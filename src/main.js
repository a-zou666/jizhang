const { invoke } = window.__TAURI__.core;
const expenses = [];
let visibleMonth = new Date();
let selectedDate = new Date();
const $ = (selector) => document.querySelector(selector);
const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const currency = (amount) => Number(amount).toFixed(2);

function renderCalendar() {
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  $("#monthLabel").textContent = `${year} 年 ${month + 1} 月`;
  $("#calendarGrid").replaceChildren();
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let index = 0; index < firstDay + daysInMonth; index += 1) {
    const day = index - firstDay + 1;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "calendar-day";
    if (day < 1) { cell.disabled = true; cell.classList.add("empty"); }
    else {
      const date = new Date(year, month, day);
      const dateKey = formatDate(date);
      const dayExpenses = expenses.filter((expense) => expense.date === dateKey);
      cell.innerHTML = `<span>${day}</span>${dayExpenses.length ? `<small>¥${currency(dayExpenses.reduce((sum, item) => sum + item.amount, 0))}</small>` : ""}`;
      if (dateKey === formatDate(selectedDate)) cell.classList.add("selected");
      if (dateKey === formatDate(new Date())) cell.classList.add("today");
      cell.addEventListener("click", () => { selectedDate = date; render(); });
    }
    $("#calendarGrid").append(cell);
  }
}

function renderSummary() {
  const monthKey = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, "0")}`;
  const monthExpenses = expenses.filter((expense) => expense.date.startsWith(monthKey));
  const todayExpenses = expenses.filter((expense) => expense.date === formatDate(new Date()));
  $("#monthTotal").textContent = currency(monthExpenses.reduce((sum, item) => sum + item.amount, 0));
  $("#monthCount").textContent = monthExpenses.length ? `${monthExpenses.length} 笔记录` : "暂无记录";
  $("#todayTotal").textContent = currency(todayExpenses.reduce((sum, item) => sum + item.amount, 0));
  $("#todayCount").textContent = todayExpenses.length ? `${todayExpenses.length} 笔记录` : "准备开始记录";
}

function renderRecords() {
  const dateKey = formatDate(selectedDate);
  const selectedExpenses = expenses.filter((expense) => expense.date === dateKey);
  $("#recordsTitle").textContent = dateKey === formatDate(new Date()) ? "今日账单" : `${selectedDate.getMonth() + 1} 月 ${selectedDate.getDate()} 日账单`;
  $("#expenseList").replaceChildren();
  if (!selectedExpenses.length) { $("#expenseList").innerHTML = '<div class="empty-state">这一天还没有账单</div>'; return; }
  selectedExpenses.forEach((expense) => { const item = document.createElement("div"); item.className = "expense-item"; item.innerHTML = `<div><strong>${expense.item}</strong><span>${expense.category}</span></div><b>-¥${currency(expense.amount)}</b>`; $("#expenseList").append(item); });
}

function render() { renderCalendar(); renderSummary(); renderRecords(); }

$("#entryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#userInput").value.trim();
  if (!text) return;
  $("#submitBtn").disabled = true;
  $("#statusText").textContent = "正在整理...";
  try {
    const parsed = await invoke("process_accounting", { text });
    expenses.push(...parsed);
    selectedDate = new Date(parsed[0]?.date ?? formatDate(new Date()));
    visibleMonth = new Date(selectedDate);
    $("#userInput").value = "";
    $("#statusText").textContent = `已记录 ${parsed.length} 笔`;
    render();
  } catch (error) { $("#statusText").textContent = "处理失败，请重试"; window.alert(`处理失败：${error}`); }
  finally { $("#submitBtn").disabled = false; }
});
$("#previousMonth").addEventListener("click", () => { visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1); render(); });
$("#nextMonth").addEventListener("click", () => { visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1); render(); });
$("#todayButton").addEventListener("click", () => { selectedDate = new Date(); visibleMonth = new Date(); render(); });
render();
