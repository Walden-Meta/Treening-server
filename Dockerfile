FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 依赖层：先拷构建元数据 + 源码，利用 Docker 构建缓存
COPY requirements.txt pyproject.toml ./
COPY src ./src
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --upgrade pip \
    && pip install --no-cache-dir gunicorn \
    # 可编辑安装：包留在 /app/src，BASE_DIR 正确解析为 /app
    # （非可编辑安装会把包装进 site-packages，导致 BASE_DIR 错算、库写进容器内层）
    && pip install --no-cache-dir -e '.[monitoring]'

# 方法论：知识树规则（app 运行时会读取）
COPY methodology ./methodology

# 操作手册：左上角 logo 下载的 PDF（/manual 路由）
COPY docs/Treening-操作手册.pdf ./docs/

# 运行时数据：SQLite + settings.json + secret，用卷持久化
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# gunicorn 直接用 bind 监听；显式指定库与方法论路径，不依赖 BASE_DIR 解析
ENV TREENING_HOST=0.0.0.0 \
    TREENING_PORT=5000 \
    TREENING_DATABASE_URL=sqlite:////app/data/tree.db \
    TREENING_METHODOLOGY_DIR=/app/methodology \
    # 生产安全开关：HTTPS 下 Secure Cookie + 位于 nginx 之后启用真实 IP 信任链
    TREENING_COOKIE_SECURE=true \
    TREENING_BEHIND_PROXY=true

EXPOSE 5000

# 单 worker 多线程：SQLite 并发写安全 + 阻塞型 LLM 请求并发友好
# --max-requests：定期回收 worker，防长期运行内存缓慢增长；jitter 避免同步重启
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "--timeout", "120", "--max-requests", "1000", "--max-requests-jitter", "100", "treening.app:app"]
