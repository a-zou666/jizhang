/**
 * 选图链路的回归测试。
 *
 * 重点盯一个坑：`<input type="file">` 的 FileList 是「活的」——紧接着执行
 * `input.value = ""` 会把它清空。曾经因为先清空再读，导致选完图界面毫无反应
 * 且不报错（用户形容为「我上传后啥都没有」）。snapshotFiles 就是为这个存在的。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareImages, snapshotFiles, __testing } from "../src/js/image.js";

/** 造一个「会被清空」的 FileList：行为和浏览器里 input.value = "" 之后一致 */
function liveFileList(files) {
  const store = [...files];
  const list = {
    get length() {
      return store.length;
    },
    item: (index) => store[index] ?? null,
    [Symbol.iterator]: () => store[Symbol.iterator](),
  };
  return {
    list,
    clear() {
      store.length = 0;
    },
  };
}

describe("snapshotFiles", () => {
  it("先把 FileList 拷成数组，之后清空 input 也不影响已取到的文件", () => {
    const { list, clear } = liveFileList([{ name: "a.jpg" }, { name: "b.jpg" }]);
    const captured = snapshotFiles(list);
    assert.equal(captured.length, 2);

    // 模拟紧接着的 input.value = ""
    clear();
    assert.equal(list.length, 0, "清空后 FileList 应当为空（浏览器行为）");
    assert.equal(captured.length, 2, "快照必须不受清空影响");
    assert.deepEqual(
      captured.map((file) => file.name),
      ["a.jpg", "b.jpg"],
    );
  });

  it("空 / null 输入返回空数组，不抛错", () => {
    assert.deepEqual(snapshotFiles(null), []);
    assert.deepEqual(snapshotFiles(undefined), []);
    assert.deepEqual(snapshotFiles([]), []);
  });

  it("过滤掉空洞项", () => {
    assert.deepEqual(snapshotFiles([{ name: "a" }, null, undefined]), [{ name: "a" }]);
  });
});

describe("prepareImages", () => {
  it("没有文件时明确报错，不静默返回空", async () => {
    await assert.rejects(() => prepareImages([]), /没有选到图片/);
    await assert.rejects(() => prepareImages(null), /没有选到图片/);
  });
});

describe("三种尺寸（送模型 / 气泡 / 预览）", () => {
  it("预览图比缩略图大、比送模型的小，三档互不相同", () => {
    const { FULL_EDGE, THUMB_EDGE, VIEW_EDGE } = __testing;
    // 缩略图只够放在气泡里，点开预览必须更大才看得清小票上的字
    assert.ok(VIEW_EDGE > THUMB_EDGE, `预览(${VIEW_EDGE}) 应大于缩略图(${THUMB_EDGE})`);
    // 预览图没必要跟送模型的一样大，省 localStorage
    assert.ok(VIEW_EDGE <= FULL_EDGE, `预览(${VIEW_EDGE}) 不该超过送模型的(${FULL_EDGE})`);
  });
});
