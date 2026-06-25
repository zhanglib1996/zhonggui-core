#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# zhonggui-core 一键安装脚本
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/zhanglib1996/zhonggui-core/main/install.sh | bash
#   curl -fsSL ... | bash -s -- --update
#   curl -fsSL ... | bash -s -- --uninstall
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ─── 管道模式检测：curl | bash 时 stdin 被管道占用 ───
# 解决方法：下载脚本到临时文件，然后从终端重新执行
if [[ ! -t 0 ]]; then
  echo "[INFO] 检测到管道模式，正在下载脚本..."
  _TMP_INSTALL=$(mktemp /tmp/zhonggui-install-XXXXXX.sh)
  curl -fsSL https://raw.githubusercontent.com/zhanglib1996/zhonggui-core/main/install.sh -o "$_TMP_INSTALL"
  chmod +x "$_TMP_INSTALL"
  # 从 /dev/tty 重新执行，确保交互式输入正常工作
  exec bash "$_TMP_INSTALL" "$@" </dev/tty
fi

# 错误处理：显示失败的行号和命令
on_error() {
  local exit_code=$?
  local line_no=$1
  echo ""
  error "安装失败 (行 $line_no, 退出码 $exit_code)"
  error "查看详细日志: $LOG_FILE"
  exit $exit_code
}
trap 'on_error $LINENO' ERR

# ─── 配置 ───
REPO_URL="https://github.com/zhanglib1996/zhonggui-core.git"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="$HOME/zhonggui-core"
LOG_FILE="/tmp/zhonggui-install-$(date +%Y%m%d%H%M%S).log"
SERVICE_PORT=3002

# ─── 颜色 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── 工具函数 ───
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }
log()     { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

confirm() {
  local msg="${1:-Continue?}"
  if [[ "$NON_INTERACTIVE" == "true" ]]; then return 0; fi
  read -rp "$(echo -e "${YELLOW}$msg [Y/n]${NC} ")" answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

prompt_with_default() {
  local var_name="$1" default="$2" prompt="$3"
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    eval "$var_name='$default'"
    return
  fi
  read -rp "$(echo -e "${CYAN}$prompt${NC} [$default]: ")" input
  eval "$var_name='${input:-$default}'"
}

prompt_secret() {
  local var_name="$1" prompt="$2"
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    eval "$var_name=''"
    return
  fi
  read -rsp "$(echo -e "${CYAN}$prompt${NC}: ")" input
  echo
  eval "$var_name='$input'"
}

generate_random() {
  openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32
}

# ─── Banner ───
show_banner() {
  echo -e "${CYAN}"
  cat << 'EOF'

  ╔══════════════════════════════════════════╗
  ║      zhonggui-core 一键安装脚本         ║
  ║      中规院智能体核心服务 v0.1.0         ║
  ╚══════════════════════════════════════════╝

EOF
  echo -e "${NC}"
}

# ─── 参数解析 ───
BRANCH="$DEFAULT_BRANCH"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
NON_INTERACTIVE=false
ACTION="install"

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch)      BRANCH="$2"; shift 2 ;;
      --install-dir) INSTALL_DIR="$2"; shift 2 ;;
      --non-interactive) NON_INTERACTIVE=true; shift ;;
      --update)      ACTION="update"; shift ;;
      --uninstall)   ACTION="uninstall"; shift ;;
      --help|-h)
        echo "用法: install.sh [选项]"
        echo ""
        echo "选项:"
        echo "  --branch <BRANCH>      指定分支 (默认: main)"
        echo "  --install-dir <DIR>    安装目录 (默认: ~/zhonggui-core)"
        echo "  --non-interactive      非交互模式，使用默认值"
        echo "  --update               更新已有安装"
        echo "  --uninstall            卸载服务"
        echo "  --help                 显示帮助"
        exit 0
        ;;
      *) die "未知参数: $1" ;;
    esac
  done
}

# ─── 系统检测 ───
check_system() {
  info "检测系统环境..."

  # 检测 OS
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VERSION="$VERSION_ID"
    OS_CODENAME="${VERSION_CODENAME:-}"
  else
    die "无法检测操作系统，仅支持 Debian/Ubuntu"
  fi

  case "$OS_ID" in
    debian|ubuntu|linuxmint) ;;
    *) warn "未经测试的系统: $OS_ID，可能存在问题" ;;
  esac

  # 检测架构
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "不支持的架构: $ARCH" ;;
  esac

  # 检测权限
  if [[ $EUID -eq 0 ]]; then
    SUDO=""
  elif command -v sudo &>/dev/null; then
    SUDO="sudo"
  else
    die "需要 root 权限或 sudo"
  fi

  # 检测资源
  CPU_CORES=$(nproc 2>/dev/null || echo 1)
  MEM_MB=$(free -m 2>/dev/null | awk '/Mem:/ {print $2}' || echo 0)
  DISK_GB=$(df -BG "$HOME" 2>/dev/null | awk 'NR==2 {print $4}' | tr -d 'G' || echo 0)

  success "系统: $OS_ID $OS_VERSION ($ARCH)"
  info "资源: ${CPU_CORES}核 CPU / ${MEM_MB}MB 内存 / ${DISK_GB}GB 可用磁盘"

  if [[ "$MEM_MB" -lt 2048 ]]; then
    warn "内存不足 2GB，建议至少 4GB"
  fi
}

# ─── Docker 安装 ───
check_docker() {
  if command -v docker &>/dev/null && docker compose version &>/dev/null; then
    DOCKER_VERSION=$(docker --version | awk '{print $3}' | tr -d ',')
    success "Docker 已安装: $DOCKER_VERSION"
    return 0
  fi
  return 1
}

install_docker() {
  info "安装 Docker..."

  # 清理可能存在的旧锁文件
  $SUDO rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock 2>/dev/null

  $SUDO apt-get update >> "$LOG_FILE" 2>&1 || die "apt-get update 失败，请检查网络连接"
  $SUDO apt-get install -y ca-certificates curl gnupg >> "$LOG_FILE" 2>&1 || die "安装基础依赖失败"

  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/$OS_ID/gpg | $SUDO gpg --yes --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg

  # 使用代号（如 bookworm）而非版本号（如 12）
  local distro_codename="${OS_CODENAME:-$OS_VERSION}"
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_ID $distro_codename stable" | \
    $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null

  $SUDO apt-get update >> "$LOG_FILE" 2>&1 || die "Docker 源更新失败，请检查网络连接"
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >> "$LOG_FILE" 2>&1 || die "Docker 安装失败"

  # 将当前用户加入 docker 组
  if [[ $EUID -ne 0 ]]; then
    $SUDO usermod -aG docker "$USER"
    warn "已将 $USER 加入 docker 组，可能需要重新登录才能生效"
    warn "如果 docker 命令权限不足，请执行: newgrp docker"
  fi

  success "Docker 安装完成"
}

# ─── 项目安装 ───
clone_repo() {
  info "克隆项目到 $INSTALL_DIR..."

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    warn "目录已存在: $INSTALL_DIR"
    if confirm "是否更新到最新版本？"; then
      cd "$INSTALL_DIR"
      git fetch origin "$BRANCH" >> "$LOG_FILE" 2>&1
      git checkout "$BRANCH" >> "$LOG_FILE" 2>&1
      git reset --hard "origin/$BRANCH" >> "$LOG_FILE" 2>&1
      success "已更新到最新版本"
      return 0
    else
      die "安装目录已存在，请手动处理或使用 --install-dir 指定其他目录"
    fi
  fi

  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" >> "$LOG_FILE" 2>&1
  success "项目克隆完成"
}

update_repo() {
  info "更新项目..."

  if [[ ! -d "$INSTALL_DIR/.git" ]]; then
    die "未找到安装目录: $INSTALL_DIR，请先执行安装"
  fi

  cd "$INSTALL_DIR"
  git fetch origin "$BRANCH" >> "$LOG_FILE" 2>&1
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$BRANCH")

  if [[ "$LOCAL" == "$REMOTE" ]]; then
    success "已是最新版本"
    return 0
  fi

  git reset --hard "origin/$BRANCH" >> "$LOG_FILE" 2>&1
  CHANGES=$(git log --oneline "$LOCAL".."$REMOTE" | wc -l)
  success "已更新 ($CHANGES 个提交)"
}

# ─── 环境配置 ───
configure_env() {
  info "配置环境变量..."

  local env_file="$INSTALL_DIR/.env"

  # 如果已存在 .env，询问是否重新配置
  if [[ -f "$env_file" ]]; then
    if ! confirm "检测到已有 .env 配置，是否重新配置？"; then
      return 0
    fi
  fi

  echo ""
  echo -e "${BOLD}─── LLM 模型配置 ───${NC}"
  echo "请配置 LLM API 信息（用于 AI 对话功能）"
  echo ""

  prompt_with_default MODEL_BASE_URL "https://api.openai.com/v1" "API Base URL"
  prompt_secret MODEL_API_KEY "API Key"

  if [[ -z "$MODEL_API_KEY" ]]; then
    warn "未设置 API Key，LLM 功能将不可用"
  fi

  prompt_with_default MODEL_NAME "mimo-v2.5-pro" "模型名称"
  prompt_with_default MODEL_PROVIDER "openai" "模型提供商 (openai/anthropic/...)"  echo ""
  echo -e "${BOLD}─── 安全配置 ───${NC}"

  local pg_password jwt_secret refresh_secret
  pg_password=$(generate_random)
  jwt_secret=$(generate_random)
  refresh_secret=$(generate_random)

  prompt_with_default PG_PASSWORD "$pg_password" "PostgreSQL 密码"
  prompt_with_default JWT_SECRET "$jwt_secret" "JWT 密钥 (至少32字符)"
  prompt_with_default REFRESH_SECRET "$refresh_secret" "Refresh Token 密钥"

  echo ""
  if confirm "是否启用开发模式（跳过认证）？"; then
    DEV_AUTH_BYPASS="true"
  else
    DEV_AUTH_BYPASS="false"
  fi

  # 写入 .env
  cat > "$env_file" << EOF
# ─── 服务配置 ───
NODE_ENV=development
PORT=3000

# ─── PostgreSQL ───
PG_HOST=postgres
PG_PORT=5432
PG_DATABASE=zhonggui_core
PG_USER=zhonggui
PG_PASSWORD=$PG_PASSWORD

# ─── Valkey ───
VALKEY_HOST=valkey
VALKEY_PORT=6379

# ─── LLM 模型 ───
MODEL_NAME=$MODEL_NAME
MODEL_PROVIDER=$MODEL_PROVIDER
MODEL_BASE_URL=$MODEL_BASE_URL
MODEL_API_KEY=$MODEL_API_KEY

# ─── 安全 ───
JWT_SECRET=$JWT_SECRET
REFRESH_SECRET=$REFRESH_SECRET
DEV_AUTH_BYPASS=$DEV_AUTH_BYPASS
ADMIN_USERS=admin
EOF

  success "环境配置完成: $env_file"
}

# ─── 构建镜像 ───
build_image() {
  info "构建 Docker 镜像（首次需要 3-5 分钟）..."

  cd "$INSTALL_DIR"
  # 显示构建进度，同时记录到日志
  if docker build --network host -t zhonggui-core:latest . 2>&1 | tee -a "$LOG_FILE"; then
    success "镜像构建完成"
  else
    error "镜像构建失败，查看日志: $LOG_FILE"
    return 1
  fi
}

# ─── 启动服务 ───
start_services() {
  info "启动服务..."

  cd "$INSTALL_DIR"

  # 停止旧容器（如果有）
  docker compose down >> "$LOG_FILE" 2>&1 || true

  # 启动所有服务
  docker compose up -d >> "$LOG_FILE" 2>&1

  success "服务启动完成"
}

# ─── 健康检查 ───
health_check() {
  info "等待服务就绪..."

  local max_wait=60
  local waited=0

  while [[ $waited -lt $max_wait ]]; do
    if curl -sf "http://localhost:$SERVICE_PORT/health" > /dev/null 2>&1; then
      success "服务已就绪"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
    echo -n "."
  done

  echo ""
  warn "服务启动超时，请检查日志: docker compose -f $INSTALL_DIR/docker-compose.yml logs"
  return 1
}

# ─── 卸载 ───
uninstall() {
  echo -e "${RED}"
  echo "╔══════════════════════════════════════════╗"
  echo "║           卸载 zhonggui-core             ║"
  echo "╚══════════════════════════════════════════╝"
  echo -e "${NC}"

  if [[ ! -d "$INSTALL_DIR" ]]; then
    warn "未找到安装目录: $INSTALL_DIR"
    return 0
  fi

  if ! confirm "确定要卸载吗？这将停止所有服务并删除数据。"; then
    info "取消卸载"
    return 0
  fi

  info "停止服务..."
  cd "$INSTALL_DIR"
  docker compose down -v >> "$LOG_FILE" 2>&1 || true

  info "删除镜像..."
  docker rmi zhonggui-core:latest >> "$LOG_FILE" 2>&1 || true

  info "删除文件..."
  rm -rf "$INSTALL_DIR"

  success "卸载完成"
}

# ─── 显示结果 ───
show_result() {
  echo ""
  echo -e "${GREEN}"
  echo "╔══════════════════════════════════════════╗"
  echo "║         安装完成！                       ║"
  echo "╚══════════════════════════════════════════╝"
  echo -e "${NC}"
  echo ""
  echo -e "  ${BOLD}访问地址:${NC}  http://localhost:$SERVICE_PORT"
  echo -e "  ${BOLD}健康检查:${NC}  curl http://localhost:$SERVICE_PORT/health"
  echo -e "  ${BOLD}安装目录:${NC}  $INSTALL_DIR"
  echo -e "  ${BOLD}配置文件:${NC}  $INSTALL_DIR/.env"
  echo -e "  ${BOLD}安装日志:${NC}  $LOG_FILE"
  echo ""
  echo -e "  ${BOLD}常用命令:${NC}"
  echo "    cd $INSTALL_DIR"
  echo "    docker compose ps          # 查看服务状态"
  echo "    docker compose logs -f     # 查看日志"
  echo "    docker compose restart     # 重启服务"
  echo "    docker compose down        # 停止服务"
  echo ""
  echo -e "  ${BOLD}更新版本:${NC}"
  echo "    curl -fsSL https://raw.githubusercontent.com/zhanglib1996/zhonggui-core/main/install.sh | bash -s -- --update"
  echo ""
}

# ─── 主流程 ───
main() {
  parse_args "$@"

  # 初始化日志
  touch "$LOG_FILE"
  log "=== zhonggui-core 安装开始 ==="
  log "Action: $ACTION, Branch: $BRANCH, Dir: $INSTALL_DIR"

  show_banner

  case "$ACTION" in
    uninstall)
      uninstall
      exit 0
      ;;
    update)
      update_repo
      build_image
      start_services
      health_check
      show_result
      exit 0
      ;;
  esac

  # 安装流程
  check_system

  if ! check_docker; then
    install_docker
  fi

  clone_repo
  configure_env
  build_image
  start_services
  health_check
  show_result

  log "=== 安装完成 ==="
}

main "$@"
