/** 手势：列表项左滑展开删除 / 长按触发 / 日历横向翻月 */

const openRows = new Set();

/** 收起所有已展开的滑动行 */
export function closeOpenRows(except = null) {
  for (const row of [...openRows]) {
    if (row.node !== except) row.close();
  }
}

/**
 * 左滑露出删除按钮
 * @param {HTMLElement} row 行容器（position: relative; overflow: hidden）
 * @param {HTMLElement} main 可滑动的行内容
 * @param {{ width?: number, openClass?: string }} options
 */
export function attachSwipeReveal(row, main, { width = 76, openClass = "is-open" } = {}) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let moved = false;

  const isOpen = () => row.classList.contains(openClass);

  const handle = {
    node: row,
    close: () => setOpen(false),
    isOpen,
  };

  function setOpen(open) {
    if (open) {
      closeOpenRows(row);
      openRows.add(handle);
    } else {
      openRows.delete(handle);
    }
    row.classList.toggle(openClass, open);
  }

  main.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
    moved = false;
    tracking = true;
  });

  main.addEventListener("pointermove", (event) => {
    if (!tracking) return;
    dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) {
      tracking = false;
      main.style.transform = "";
      return;
    }
    if (Math.abs(dx) < 6) return;
    moved = true;
    const base = isOpen() ? -width : 0;
    const offset = Math.max(-width - 24, Math.min(0, base + dx));
    main.style.transform = `translateX(${offset}px)`;
  });

  function finish() {
    if (!tracking) return;
    tracking = false;
    main.style.transform = "";
    if (!moved) return;
    const opened = isOpen();
    setOpen(dx < -30 ? true : dx > 30 ? false : opened);
  }

  main.addEventListener("pointerup", finish);
  main.addEventListener("pointercancel", finish);
  return handle;
}

/**
 * 长按触发（默认 480ms，移动超过 8px 取消）
 * @returns {() => void} 取消函数
 */
export function attachLongPress(node, handler, { ms = 480, tolerance = 8, onCancel } = {}) {
  let timer = 0;
  let startX = 0;
  let startY = 0;
  let fired = false;

  const clear = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };

  node.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    fired = false;
    startX = event.clientX;
    startY = event.clientY;
    clear();
    timer = window.setTimeout(() => {
      timer = 0;
      fired = true;
      handler(event);
    }, ms);
  });

  node.addEventListener("pointermove", (event) => {
    if (!timer) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > tolerance) {
      clear();
      onCancel?.();
    }
  });

  node.addEventListener("pointerup", () => {
    if (timer) {
      clear();
      onCancel?.();
    }
  });
  node.addEventListener("pointercancel", clear);

  return clear;
}

/**
 * 横向滑动翻月
 * @param {HTMLElement} node
 * @param {{ threshold?: number, onShift: (delta: number) => void }} options
 */
export function attachHorizontalSwipe(node, { threshold = 48, onShift } = {}) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let engaged = false;
  let suppressed = false;

  node.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
    tracking = true;
    engaged = false;
    suppressed = false;
  });

  node.addEventListener("pointermove", (event) => {
    if (!tracking) return;
    dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!engaged && Math.abs(dx) < 8) return;
    if (Math.abs(dy) > Math.abs(dx) && !engaged) {
      tracking = false;
      return;
    }
    engaged = true;
    suppressed = true;
    node.classList.add("is-swiping");
    node.style.transform = `translateX(${dx * 0.35}px)`;
  });

  function finish() {
    if (!tracking) return;
    tracking = false;
    node.classList.remove("is-swiping");
    node.style.transform = "";
    if (engaged && Math.abs(dx) > threshold) onShift?.(dx < 0 ? 1 : -1);
    dx = 0;
    engaged = false;
  }

  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", finish);

  /** 滑动后抑制随后的点击 */
  return function consumeClick() {
    if (!suppressed) return false;
    suppressed = false;
    return true;
  };
}
