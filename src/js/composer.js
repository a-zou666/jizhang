/** 八、底部停靠区 · 输入条：文本/语音记账 + 快捷分类 */

import { hasBackend, parseAccounting, transcribeAudio } from "./bridge.js";
import { openConfirm } from "./confirm.js";
import { attachLongPress } from "./gesture.js";
import { icon } from "./icons.js";
import { addRecords, categoryColor, getSettings } from "./store.js";
import { closeModal, haptic, openModal, toast } from "./ui.js";
import { $, dateKey, escapeHtml, round2 } from "./util.js";
import { view } from "./view.js";

const SpeechRecognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

/** 是否运行在 Tauri 打包的移动端（Android / iOS WebView） */
function isMobileShell() {
  return Boolean(globalThis.__TAURI__) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** 麦克风失败的中文可操作提示：区分权限 / 无设备 / 被占用 */
function microphoneErrorText(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return isMobileShell()
        ? "系统未授权麦克风：请到「设置 → 应用 → AI 记账 → 权限」中开启麦克风权限"
        : "浏览器拒绝了麦克风权限，请在地址栏权限设置中允许后重试";
    case "NotFoundError":
    case "OverconstrainedError":
      return "没有检测到可用的麦克风设备";
    case "NotReadableError":
    case "AbortError":
      return "麦克风被其他应用占用，请关闭后重试";
    case "TimeoutError":
      return "等待麦克风授权超时：请确认系统权限弹窗是否被拦截，或到系统设置里手动开启麦克风";
    default:
      return `无法访问麦克风：${error?.message ?? error}`;
  }
}

/** 等待 getUserMedia 的结果，带超时（避免 Android 授权框挂起时长按状态锁死） */
function getAudioStream(timeoutMs = 8000) {
  const pending = navigator.mediaDevices.getUserMedia({ audio: true });
  const timeout = new Promise((_, reject) => {
    window.setTimeout(() => reject(Object.assign(new Error("麦克风授权超时"), { name: "TimeoutError" })), timeoutMs);
  });
  return Promise.race([pending, timeout]);
}

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
      const { records, skipped } = await parseAccounting(text, getSettings());
      if (!records.length) {
        toast(
          skipped ? `识别到 ${skipped} 条，但都缺少金额或日期` : "没能识别出账单，换个说法试试",
          "error",
        );
        return;
      }
      if (skipped) toast(`另有 ${skipped} 条缺少金额或日期，已跳过`, "warning");
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
    if (!SpeechRecognition) return { engine: null };
    const instance = new SpeechRecognition();
    instance.lang = "zh-CN";
    instance.interimResults = true;
    instance.continuous = false;
    let transcript = "";
    /** 是否已就本次识别给出过错误提示，避免权限失败时叠加多条 toast */
    let reported = false;

    instance.onresult = (event) => {
      let text = "";
      for (const result of event.results) text += result[0].transcript;
      transcript = text;
      hint.textContent = text || "松手转文字";
    };
    instance.onerror = (event) => {
      hideWave();
      if (event.error === "aborted" || event.error === "no-speech") return;
      reported = true;
      // not-allowed / service-not-allowed 都是权限或不可用，统一给可操作提示
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast(microphoneErrorText({ name: "NotAllowedError" }), "error");
      } else if (event.error === "audio-capture") {
        toast("没有检测到可用的麦克风设备", "error");
      } else if (event.error === "network") {
        toast("语音识别网络异常，请改用系统语音输入", "error");
      } else {
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
      return { engine: null, errored: reported };
    }
    return { engine: instance };
  }

  /** 方案 B：MediaRecorder + 后端 Whisper（Android / 桌面 Tauri WebView） */
  async function startMediaRecorder() {
    const SR = globalThis.MediaRecorder;
    if (!SR || !navigator.mediaDevices?.getUserMedia) return { engine: null };
    try {
      // 请求麦克风权限：Android 上由 Wry 的 WebChromeClient 触发系统授权框
      recorderStream = await getAudioStream();
    } catch (error) {
      console.error("[composer] 麦克风权限被拒绝或不可用:", error);
      toast(microphoneErrorText(error), "error");
      return { engine: null, errored: true };
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
      if (recorderStream) {
        recorderStream.getTracks().forEach((track) => track.stop());
        recorderStream = null;
      }
      return { engine: null, errored: true };
    }
    return { engine: instance };
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
    // 顺序：先试浏览器原生识别（最快、无需 API Key），失败再走录音 + 后端 Whisper。
    // 关键：一旦某个引擎已经给出错误提示，就不再叠加第二次尝试，
    // 否则 Android WebView 上会出现「无法访问麦克风 + 语音识别失败」两条 toast。
    if (SpeechRecognition) {
      const result = startWebSpeech();
      if (result.engine) return { kind: "web", instance: result.engine, errored: false };
      if (result.errored) return null;
    }

    const backend = hasBackend();
    const recorderAvailable = typeof MediaRecorder !== "undefined";
    if (backend && recorderAvailable) {
      const result = await startMediaRecorder();
      if (result.engine) return { kind: "media", instance: result.engine, errored: false };
      if (result.errored) return null;
    }

    if (!SpeechRecognition && !recorderAvailable) {
      toast("当前设备不支持语音录入，请用键盘输入", "error");
    } else if (!backend) {
      toast("语音转文字需要连接 AI 后端，请先在设置里配置 API Key", "error");
      onNeedSettings?.();
    } else {
      toast("语音录入启动失败，请重试或改用键盘输入", "error");
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
