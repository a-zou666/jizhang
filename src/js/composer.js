/** 八、底部悬浮输入条：文本/语音记账 + 快捷分类 */

import { hasBackend, parseAccounting, transcribeAudio } from "./bridge.js";
import { openConfirm } from "./confirm.js";
import { attachLongPress } from "./gesture.js";
import { icon } from "./icons.js";
import { addRecords, categoryColor, getSettings } from "./store.js";
import { closeModal, haptic, openModal, toast } from "./ui.js";
import { $, dateKey, escapeHtml, round2 } from "./util.js";
import { view } from "./view.js";

const SpeechRecognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export function bindComposer({ onNeedSettings } = {}) {
  const form = $("#composer");
  const input = $("#composerInput");
  const action = $("#composerAction");
  const plus = $("#composerPlus");
  const wave = $("#voiceWave");
  const hint = $("#voiceHint");

  let busy = false;
  let sendMode = false;
  /** 语音引擎：web 走 SpeechRecognition，无则走 MediaRecorder + 后端 Whisper */
  let recognition = null;
  let recordedChunks = [];
  let recordedMime = "";
  let recorderStream = null;
  let voicePressHeld = false;

  /* ---------------- 输入激活态：麦克风 → 发送 ---------------- */
  function setSendMode(on) {
    if (sendMode === on) return;
    sendMode = on;
    form.classList.toggle("is-active", on);
    action.classList.toggle("is-send", on);
    action.setAttribute("aria-label", on ? "发送" : "语音输入");
    action.innerHTML = icon(on ? "send" : "mic", { size: 22 });
  }

  input.addEventListener("focus", () => setSendMode(true));
  input.addEventListener("input", () => setSendMode(Boolean(input.value.trim())));
  input.addEventListener("blur", () => {
    if (!input.value.trim()) setSendMode(false);
  });

  /* ---------------- 解析入账 ---------------- */
  async function submit(raw) {
    const text = String(raw ?? "").trim();
    if (!text || busy) return;
    if (hasBackend() && !getSettings().apiKey) {
      toast("请先在设置里配置 API Key", "error");
      onNeedSettings?.();
      return;
    }

    busy = true;
    action.disabled = true;
    const loading = toast("AI 正在解析…");
    try {
      const records = await parseAccounting(text, getSettings());
      if (!records.length) {
        toast("没能识别出账单，换个说法试试", "error");
        return;
      }
      input.value = "";
      input.blur();
      setSendMode(false);
      openConfirm(records);
    } catch (error) {
      toast(`解析失败：${String(error?.message ?? error)}`, "error");
    } finally {
      busy = false;
      action.disabled = false;
      loading.remove();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(input.value);
  });

  action.addEventListener("click", () => {
    if (sendMode) submit(input.value);
  });

  /* ---------------- 语音（长按） ---------------- */
  const showWave = () => {
    hint.textContent = "松手转文字";
    wave.classList.add("is-open");
    haptic(12);
  };
  const hideWave = () => {
    wave.classList.remove("is-open");
    hint.textContent = "松手转文字";
  };

  /** 方案 A：Web SpeechRecognition（浏览器 / 部分 WebView） */
  function startWebSpeech() {
    if (!SpeechRecognition) return null;
    const instance = new SpeechRecognition();
    instance.lang = "zh-CN";
    instance.interimResults = true;
    instance.continuous = false;
    let transcript = "";

    instance.onresult = (event) => {
      let text = "";
      for (const result of event.results) text += result[0].transcript;
      transcript = text;
      hint.textContent = text || "松手转文字";
    };
    instance.onerror = (event) => {
      hideWave();
      if (event.error !== "aborted" && event.error !== "no-speech") {
        toast(`语音识别失败：${event.error}`, "error");
      }
    };
    instance.onend = () => {
      hideWave();
      if (transcript.trim()) submit(transcript);
    };

    try {
      instance.start();
    } catch (error) {
      console.warn("[composer] 语音识别启动失败", error);
      return null;
    }
    return instance;
  }

  /** 方案 B：MediaRecorder + 后端 Whisper（Android / 桌面 Tauri WebView） */
  async function startMediaRecorder() {
    const SR = globalThis.MediaRecorder;
    if (!SR) return null;
    try {
      recorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      toast(`无法访问麦克风：${error?.message ?? error}`, "error");
      return null;
    }
    const mime = pickRecorderMime();
    recordedChunks = [];
    recordedMime = mime;
    const instance = mime ? new SR(recorderStream, { mimeType: mime }) : new SR(recorderStream);
    instance.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    });
    instance.addEventListener("error", (event) => {
      console.warn("[composer] MediaRecorder 错误", event);
    });
    try {
      instance.start(250);
    } catch (error) {
      console.warn("[composer] MediaRecorder 启动失败", error);
      return null;
    }
    return instance;
  }

  function pickRecorderMime() {
    if (typeof MediaRecorder === "undefined") return "";
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    for (const type of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(type)) return type;
      } catch {
        /* 忽略 */
      }
    }
    return "";
  }

  async function stopMediaRecorder(instance) {
    if (!instance) return;
    if (instance.state !== "inactive") {
      try {
        instance.stop();
      } catch {
        /* 忽略 */
      }
    }
    if (recorderStream) {
      recorderStream.getTracks().forEach((track) => track.stop());
      recorderStream = null;
    }
    if (!recordedChunks.length) return;
    const blob = new Blob(recordedChunks, { type: recordedMime || "audio/webm" });
    recordedChunks = [];
    if (blob.size < 1024) {
      toast("录音太短，请再试一次", "error");
      return;
    }
    const settings = getSettings();
    if (!settings.apiKey) {
      toast("请先在设置里配置 API Key", "error");
      onNeedSettings?.();
      return;
    }
    const loading = toast("正在转写…");
    try {
      const text = await transcribeAudio(settings, blob);
      if (text) submit(text);
      else toast("没有识别到内容，再试一次", "error");
    } catch (error) {
      toast(`转写失败：${String(error?.message ?? error)}`, "error");
    } finally {
      loading.remove();
    }
  }

  async function startVoice() {
    // 优先 WebSpeech；否则 MediaRecorder + Whisper
    if (SpeechRecognition) return { kind: "web", instance: startWebSpeech() };
    if (hasBackend() && typeof MediaRecorder !== "undefined") {
      const instance = await startMediaRecorder();
      if (instance) return { kind: "media", instance };
    }
    if (!SpeechRecognition && typeof MediaRecorder === "undefined") {
      toast("当前环境不支持语音录入，请用键盘输入", "error");
    } else if (!hasBackend()) {
      toast("浏览器预览下不支持语音转文字，请用键盘输入", "error");
    }
    return null;
  }

  /** MediaRecorder 模式的视觉提示（屏幕中央波纹） */
  const showRecording = () => {
    hint.textContent = "录音中…松手结束";
    wave.classList.add("is-open", "is-recording");
    haptic(12);
  };
  const hideRecording = () => {
    wave.classList.remove("is-open", "is-recording");
    hint.textContent = "松手转文字";
  };

  async function stopVoice() {
    if (!recognition) return;
    const engine = recognition;
    recognition = null;
    if (engine.kind === "web") {
      try {
        engine.instance.stop();
      } catch {
        /* 忽略 */
      }
    } else if (engine.kind === "media") {
      await stopMediaRecorder(engine.instance);
    }
  }

  action.addEventListener("pointerdown", () => {
    if (!sendMode) voicePressHeld = true;
  });

  attachLongPress(
    action,
    async () => {
      if (sendMode || busy || !voicePressHeld) return;
      const engine = await startVoice();
      if (!engine?.instance) return;
      if (!voicePressHeld) {
        if (engine.kind === "web") engine.instance.stop();
        else await stopMediaRecorder(engine.instance);
        return;
      }
      recognition = engine;
      if (engine.kind === "media") showRecording();
      else showWave();
    },
    { ms: 260, tolerance: 14 },
  );

  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    action.addEventListener(type, () => {
      voicePressHeld = false;
      stopVoice();
    });
  }

  /* ---------------- 快捷分类记账 ---------------- */
  plus.addEventListener("click", () => {
    haptic();
    openQuickAdd();
  });
}

/** 「+」快捷记账：分类色板 + 物品 + 金额 */
function openQuickAdd() {
  const { categories } = getSettings();
  const selected = categories[0];
  const chips = categories
    .map(
      (name) => `
      <button class="chip${name === selected ? " is-selected" : ""}" data-cat="${escapeHtml(name)}" type="button">
        <span class="calendar-cell__dot" style="background:${categoryColor(name)}"></span>${escapeHtml(name)}
      </button>`,
    )
    .join("");

  openModal(
    `<p class="modal-title">快捷记账</p>
     <div class="field-stack">
       <label class="field-label">分类</label>
       <div class="chip-row" id="qaCats">${chips}</div>
       <label class="field-label" for="qaItem">物品</label>
       <input class="settings-input" id="qaItem" type="text" placeholder="买了什么" />
       <label class="field-label" for="qaAmount">金额</label>
       <input class="settings-input" id="qaAmount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" />
     </div>
     <div class="modal-actions">
       <button class="ghost-btn" id="qaCancel" type="button">取消</button>
       <button class="primary-btn primary-btn--compact" id="qaSave" type="button">记一笔</button>
     </div>`,
    {
      onMount: (panel) => {
        let category = selected;
        panel.querySelectorAll("#qaCats .chip").forEach((chip) => {
          chip.addEventListener("click", () => {
            category = chip.dataset.cat;
            panel
              .querySelectorAll("#qaCats .chip")
              .forEach((node) => node.classList.toggle("is-selected", node === chip));
          });
        });

        panel.querySelector("#qaCancel").addEventListener("click", closeModal);
        panel.querySelector("#qaSave").addEventListener("click", () => {
          const item = panel.querySelector("#qaItem").value.trim();
          const amount = round2(Math.abs(Number(panel.querySelector("#qaAmount").value)));
          if (!item) return toast("请填写物品名称", "error");
          if (!Number.isFinite(amount) || amount <= 0) return toast("请填写有效金额", "error");
          closeModal();
          addRecords([{ date: dateKey(view.selected), item, category, amount }]);
          toast("已记一笔", "ok");
        });

        panel.querySelector("#qaItem").focus();
      },
    },
  );
}
