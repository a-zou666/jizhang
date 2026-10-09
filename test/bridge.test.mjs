/**
 * 识图报错文案的回归测试。
 *
 * 之前用「出现 400 或 image 字样就算模型不支持识图」的宽判断，把 Key 错、额度用完、
 * 参数非法这些跟图片无关的失败全报成了「换视觉模型」，属于误诊。这里把边界钉死。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeImageError, isImageUnsupported } from "../src/js/bridge.js";

describe("isImageUnsupported", () => {
  it("服务端明确说了图片能力才算不支持", () => {
    const yes = [
      "接口返回 HTTP 400：this model does not support image input",
      "接口返回 HTTP 400：images are not supported by this model",
      "接口返回 HTTP 400：unsupported image format",
      "接口返回 HTTP 400：invalid image data",
      "接口返回 HTTP 400：image_url is not supported",
      "接口返回 HTTP 400：vision capability required",
      "接口返回 HTTP 400：text-only model",
      "接口返回 HTTP 400：该模型不支持图片输入",
      "接口返回 HTTP 400：图片不支持",
    ];
    for (const message of yes) {
      assert.equal(isImageUnsupported(message), true, `应当判为不支持：${message}`);
    }
  });

  it("跟图片无关的失败不能被误判成「模型不支持识图」", () => {
    const no = [
      "接口返回 HTTP 400：invalid api key",
      "接口返回 HTTP 400：insufficient quota",
      "接口返回 HTTP 401：unauthorized",
      "接口返回 HTTP 404：model not found",
      "网络请求失败: connection refused",
      "模型 25 秒未响应，请稍后重试或换一个模型",
      "接口返回 HTTP 400：messages must not be empty",
    ];
    for (const message of no) {
      assert.equal(isImageUnsupported(message), false, `不该判为不支持：${message}`);
    }
  });
});

describe("describeImageError", () => {
  it("真不支持图片时才提示换视觉模型，并带上服务端原文", () => {
    const error = describeImageError(
      new Error("接口返回 HTTP 400：this model does not support image"),
      "deepseek-chat",
    );
    assert.match(error.message, /deepseek-chat/);
    assert.match(error.message, /换一个视觉模型/);
    assert.match(error.message, /服务端原文/);
  });

  it("其余失败原样透出服务端信息，不甩锅给模型", () => {
    const raw = "接口返回 HTTP 400：invalid api key";
    const error = describeImageError(new Error(raw), "glm-4.6v-flash");
    assert.equal(error.message, raw);
    assert.doesNotMatch(error.message, /不支持识图/);
  });

  it("超时仍然报超时", () => {
    const error = describeImageError(new Error("请求超时"), "glm-4.6v-flash");
    assert.match(error.message, /25 秒未响应/);
  });
});
