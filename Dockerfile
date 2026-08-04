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
    && pip install --no-cache-dir .

# 方法论：知识树规则（app 运行时会读取）
COPY methodology ./methodology

# 运行时数据：SQLite + settings.json + secret，用卷持久化
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# gunicorn 直接用 bind 监听，不依赖 TEXTREE_HOST
ENV TEXTREE_HOST=0.0.0.0 \
    TEXTREE_PORT=5000 \
    TEXTREE_DATABASE_URL=sqlite:///data/tree.db

EXPOSE 5000

# 单 worker 多线程：SQLite 并发写安全 + 阻塞型 LLM 请求并发友好
# --max-requests：定期回收 worker，防长期运行内存缓慢增长；jitter 避免同步重启
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "--timeout", "120", "--max-requests", "1000", "--max-requests-jitter", "100", "textree.app:app"]
