// deconBlock 从 tree.js（IIFE）中提取后独立测试。它是纯函数：
// node.metadata[key] → 清洗后的块文本（按 maxLen 截断）。
// 提取器是 JS 感知的：跳过字符串/模板串（含插值）/正则/注释，
// 因此正则字面量里的 `}` 不会误判函数右括号。
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function findFunctionEnd(src, braceStart) {
  let depth = 0;
  let i = braceStart;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const q = ch; i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) break;
        i++;
      }
      i++;
    } else if (ch === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") {
          i += 2; let interp = 1;
          while (i < src.length && interp > 0) {
            const c = src[i];
            if (c === "'" || c === '"' || c === "`") {
              const q2 = c; i++;
              while (i < src.length) {
                if (src[i] === "\\") { i += 2; continue; }
                if (src[i] === q2) break;
                i++;
              }
            } else if (c === "{") interp++;
            else if (c === "}") interp--;
            i++;
          }
          continue;
        }
        i++;
      }
      i++;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else if (ch === "/" && src[i + 1] !== "/" && src[i + 1] !== "*") {
      // regex literal（本函数无除法，视 / 为正则起点即可）
      i++; let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        else if (src[i] === "\n") break;
        i++;
      }
      i++;
    } else if (ch === "{") {
      depth++; i++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
    } else i++;
  }
  return -1;
}

function extractDeconBlock(src) {
  const marker = "function deconBlock(node, key, maxLen) {";
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, "deconBlock not found in tree.js");
  const braceStart = src.indexOf("{", start);
  const end = findFunctionEnd(src, braceStart);
  assert.notEqual(end, -1, "could not balance deconBlock braces");
  // eslint-disable-next-line no-eval
  const fn = eval("(" + src.slice(start, end + 1) + ")");
  assert.equal(typeof fn, "function");
  return fn;
}

const source = readFileSync(join(__dirname, "../src/treening/static/js/tree.js"), "utf8");
const deconBlock = extractDeconBlock(source);

test("plain value passes through", () => {
  const node = { metadata: { contradiction: "可靠性与握手开销之间的张力" } };
  assert.equal(deconBlock(node, "contradiction", 100), "可靠性与握手开销之间的张力");
});

test("long block is truncated at maxLen with ellipsis", () => {
  const long = "这个块内容非常长超过了长度限制所以应当被截断并加上省略号，继续填充到足够长。".repeat(5);
  const node = { metadata: { contradiction: long } };
  const out = deconBlock(node, "contradiction", 100);
  assert.equal(out.endsWith("…"), true);
  assert.ok(out.length <= 100, `length ${out.length} > 100`);
});

test("non-string or missing block returns empty string", () => {
  assert.equal(deconBlock({ metadata: {} }, "practice", 100), "");
  assert.equal(deconBlock({ metadata: { practice: null } }, "practice", 100), "");
  assert.equal(deconBlock({}, "check_question", 60), "");
  assert.equal(deconBlock(null, "check_question", 60), "");
});

test("whitespace is collapsed", () => {
  const node = { metadata: { practice: "  用  抓包工具  抓一次  握手 序列。\n\n  " } };
  assert.equal(deconBlock(node, "practice", 100), "用 抓包工具 抓一次 握手 序列。");
});

test("```json fence is stripped without leaking structure", () => {
  const node = { metadata: { contradiction: "```json\n{\"contradiction\": \"可靠性与握手开销之间的张力\"}\n```" } };
  assert.equal(deconBlock(node, "contradiction", 100), "可靠性与握手开销之间的张力");
});

test("bare JSON object literal pulls its own key", () => {
  const node = { metadata: { practice: '{"practice": "用抓包工具抓一次握手序列", "answer": "忽略我"}' } };
  assert.equal(deconBlock(node, "practice", 100), "用抓包工具抓一次握手序列");
});

test("json prefix without braces is cleaned", () => {
  const node = { metadata: { reflect_question: 'json "四次握手在什么场景下反而合理？"' } };
  assert.equal(deconBlock(node, "reflect_question", 60), "四次握手在什么场景下反而合理？");
});

test("json echo with no real content is rejected", () => {
  const node = { metadata: { inspire_question: "json" } };
  assert.equal(deconBlock(node, "inspire_question", 60), "");
});

test("answer-summary leakage into a block is pulled to the block key", () => {
  const node = {
    metadata: { check_question: '{ "answer_summary": "三次握手确认双方收发能力", "check_question": "如果只有两次握手，服务端会面临什么风险？" }' },
  };
  assert.equal(deconBlock(node, "check_question", 60), "如果只有两次握手，服务端会面临什么风险？");
});
