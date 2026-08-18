# 负载基线报告（Phase 3 本地 + 生产实测）

> 本地测试：2026-08-12 ｜ 生产实测：2026-08-12
> Git commit：`1a18663c0a3dc88de0f81de4e8e210f165b059ef`
> 压测工具链（`bench/`）为本报告对应的未提交工作区改动。
> 复现：
> - 本地：`python bench/run_all.py --duration 12 --concurrency 8 --users 6`
> - 生产：`bench/prod_seed.py` + `bench/load.py --only S1,S2,S6`（容器内直连 `127.0.0.1:5000`）

> **吞吐口径**：报告中 req/s 一律为**真实壁钟吞吐**（样本数 / 测试实际耗时），
> 非"延迟分位数跨度"公式——后者会把持续吞吐虚高 50~100 倍。

---

## 1. 环境

### 本地基线（受控实验，Mock 模型）

| 字段 | 值 |
|---|---|
| 硬件 | Intel Core i7-13700H（14 核 / 20 线程），32 GB RAM |
| 操作系统 | Windows 10 22H2，Python 3.13.13，Flask 3.1.3，SQLite 3.50.4 |
| WSGI | waitress 3.0.2（`--threads=4`，模拟生产 gunicorn） |
| LLM | Mock Provider（本地，固定 150ms 延迟），零外部成本 |
| 数据 | 500 节点大树 / 100 中树 / 30 小树 + 竞争会话 + 已完成任务 |

### 生产实测（真实线上，真实模型）

| 字段 | 值 |
|---|---|
| 服务器 | 阿里云 ECS，**2 核 / 2GB**（iZj6cctl939p5sdj22gde8Z），Linux |
| 容器 | `treening-server-treening:latest`，`gunicorn --workers 1 --threads 4 --timeout 120` |
| 数据库 | 生产 SQLite `tree.db`（12 用户 / 89 会话 / 355 节点），WAL |
| 模型 | **真实 DeepSeek**（deepseek-chat，仅读测试不调用） |
| 测试路径 | 容器内直连 `http://127.0.0.1:5000`（绕过 nginx 限流，测容器真实能力） |
| 测试数据 | 专用压测账号 `bench_prod` + 500 节点大树（用后即清，线上已还原） |

## 2. 本地基线结果（12s/档，Mock 150ms）

| 场景 | 并发 | 吞吐 | p50 | p95 | p99 | 错误率 |
|---|---|---|---|---|---|---|
| S1 读大树（500 节点全树） | 4 | 61.1 /s | 61.1 ms | 114.4 ms | 136.7 ms | 0% |
| S1 读大树 | 8 | 65.1 /s | 119.4 ms | 171.4 ms | 200.1 ms | 0% |
| S2 轮询任务 | 4 | 136.0 /s | 21.5 ms | 71.7 ms | 98.9 ms | 0% |
| S2 轮询任务 | 8 | 152.8 /s | 47.5 ms | 90.8 ms | 116.3 ms | 0% |
| S3 提问接受 | 8 | 5.6 /s 接受 | 88.0 ms | 135.3 ms | 152.6 ms | 0%* |
| S4 端到端（ask→完成） | 6×4 | 24 条 | 477.7 ms | 514.8 ms | 526.8 ms | 0% |
| S5 同槽位竞争 | 6 | 单发 | 41.8 ms | 45.3 ms | 45.3 ms | — |
| S6 导出（md/txt/docx） | 3 | 3.8 /s | 55.5 ms | 2482 ms | 2482 ms | 0% |

\* S3 另有 **1287 次 429 背压**（并发上限 6 硬限流，保护 LLM 预算），不计错误。
S5 校验：6 并发抢同一 custom 槽位 → `{202:1, 409:5}`，parent 下 custom 节点**恰好 1 个** ✅
S7 恢复：过期租约任务被清扫器回收完成 ✅

## 3. 生产实测结果（10s/档，真实容器，只读）

| 场景 | 并发 | 吞吐 | p50 | p95 | p99 | 错误 |
|---|---|---|---|---|---|---|
| S1 读大树 | 4 | 54.5 /s | 62.5 ms | 92.5 ms | 105.9 ms | 3 连接断开 (0.55%) |
| S1 读大树 | 8 | 58.7 /s | 127.5 ms | 165.8 ms | 185.7 ms | 0 |
| S2 轮询任务 | 4 | 130.2 /s | 23.7 ms | 37.6 ms | 45.5 ms | 3 连接断开 (0.23%) |
| S2 轮询任务 | 8 | 147.9 /s | 46.1 ms | 63.4 ms | 73.0 ms | 2 连接断开 (0.14%) |
| S6 导出 md/txt | 3 | 1.2 /s | 48.2 ms | 70.0 ms | 70.0 ms | 6 次 docx 503 |

压测期间 2GB 内存仅增约 21MB，容器全程 `healthy`，线上无感。

## 4. 本地 vs 生产对比（c8 持续吞吐）

| 场景 | 本地(20线程) | 生产(2核) | 生产相对本地 |
|---|---|---|---|
| S1 读大树 | 65.1 /s | 58.7 /s | **90%** |
| S2 轮询 | 152.8 /s | 147.9 /s | **97%** |
| S1 p50 延迟 | 119 ms | 127 ms | 相近 |
| S2 p50 延迟 | 47 ms | 46 ms | 相同 |

**结论：2 核机器的真实吞吐只比 20 线程笔记本低 3~10%。**
瓶颈是单 gunicorn 进程内的 GIL（1 worker × 4 threads），不是核数。
并发 4→8 吞吐几乎不涨，证明 4 线程已把 GIL 打满。

## 5. 上线容量估算（诚实版）

生产单实例（1 worker × 4 threads）实测持续能力：

- **轮询读**：~148 /s。按前端轮询 ~1.4 次/s/人 计算 → **约 100 个"正在等回答"的用户**同时轮询即到上限。
- **整树读**：~59 /s（每份 223 KB，约 13 MB/s）。
- 真实使用中用户不是一直轮询（只在提问后等答案的几秒内轮询），所以 **几百并发用户可平滑承载**；要到**几千 DAU**，单实例已到临界。

**放量路径（按证据给，路线图 Phase 4 方向）**：

1. **gunicorn `--workers 2~3`**：SQLite WAL 下读进程可近乎线性扩展，2 核机器 2~3 worker 即可把读吞吐提 2~3 倍——这是最快、最便宜的一步。
2. **降轮询频 / 加 SSE 推送**：把 ~1.4 r/s 轮询降到事件推送，同时减少 148 req/s 的占用和 nginx 限流压力。
3. 写路径（提问）由 LLM 预算 + 并发上限 6 决定，后端不是瓶颈。

## 6. 生产实测发现的问题

### ✅ P0：DOCX 导出损坏 —— 已修复并发布
- 现象：导出 Word 返回 `503 {"code":"tree_docx_unavailable","error":"DOCX 导出依赖未安装"}`。
- 原因：`Dockerfile` 安装的是 `pip install -e '.[monitoring]'`，**漏了 `docx` extra**（pyproject 定义了 `docx = ["python-docx>=1.0"]`）。
- 修复（2026-08-12 发布，镜像 `20260812-105507-76049f5`）：Dockerfile 改为 `pip install --no-cache-dir -e '.[monitoring,docx]'`。
- 线上复测：`docx -> 200, 41883 bytes`（744ms 生成），md/txt 正常。

### ⚠️ P2：满负荷下偶发连接断开
- 现象：2 核机器上并发饱和时，有 ~0.2~0.5% 请求被 gunicorn 直接断开（`RemoteDisconnected`）。
- 解读：单 worker 4 线程全部繁忙时，gunicorn sync worker 的 keep-alive 连接处理出现偶发截断。

## 6.5 上线放量变更（2026-08-12 已发布）

| 项 | 改前 | 改后 | 目的 |
|---|---|---|---|
| gunicorn workers | 1（4 线程） | **2（共 8 线程）** | 读能力翻倍（WAL 下读进程近线性扩展） |
| 任务执行器（"跑"） | 2 | **10** | 并行调模型任务数上限 |
| 全局在途（"跑+排"） | 6 | **15** | 10 跑 5 排，降低 429 摩擦 |
| 单用户在途 | 2 | 2（不变） | 公平性兜底，防单用户占满 |
| docx 依赖 | 缺 | python-docx 1.2.0 | P0 修复 |

## 7. 正确性检查结果（本地 + 生产）

| 检查项 | 结果 |
|---|---|
| 分支数不超过三条 | S5 通过（竞争槽位仅 1 个 custom 子节点） |
| 无重复回答 | S5 通过（恰好 1 个胜者） |
| 无跨用户数据读取 | 通过（普通用户访问他人会话返回 404） |
| 配额未被并发绕过 | S3 通过（1287 次 429 验证上限未被绕过） |
| 成功任务有对应回答 | S7 通过；293 个单元测试兜底 |
| 数据隔离 | 生产实测用独立 `bench_prod` 账号，用后删除，线上数据零污染（已还原 12 用户/355 节点） |

## 8. 瓶颈分析

1. **GIL（单进程上限）**：本地 20 线程和线上 2 核吞吐几乎一样——瓶颈在单 gunicorn 进程的 GIL，多核救不了单进程。**解法 = 加 worker**。
2. **LLM 时延**：端到端 p50 478ms 中 ~300ms 是两阶段模型调用。写路径由并发上限 6 + 429 背压保护预算，这是特性。
3. **SQLite 单写者**：写锁由 `BEGIN IMMEDIATE` 串行化，S5 证明并发正确性无损。
4. **docx 导出**：本地 42KB 正常，线上 503（依赖缺失）——已定位为发布遗漏。
5. **nginx 限流**：`/api/` 240r/m/IP + fail2ban 封禁 429。按用户 IP 设计，正常用户不受影响；但单 IP 大规模压测不可行（这也是生产测试必须绕 nginx 直连容器的原因）。

## 9. 复现

```bash
# 本地（Mock 模型，零成本）
cd bench && python run_all.py --duration 12 --concurrency 8 --users 6

# 生产（只读，绕过 nginx，测容器真实能力）
scp bench/prod_seed.py bench/load.py root@<server>:/tmp/
docker cp /tmp/prod_seed.py treening:/tmp/ && docker cp /tmp/load.py treening:/tmp/
docker exec treening python /tmp/prod_seed.py
docker exec treening python /tmp/load.py --base http://127.0.0.1:5000 \
  --seed-file /tmp/seed_info.json --out /tmp/report_prod.json \
  --duration 10 --concurrency 8 --only S1,S2,S6
docker exec treening python /tmp/prod_cleanup.py   # 测完必清
```
