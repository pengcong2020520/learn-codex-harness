// 阶段演示页的机制动画：每一步高亮源码行、把一条消息从一个角色送到另一个角色、更新角色状态和右侧状态表。
// 数据写在每个 .mech 的 data-mech 属性里（由 build-changes-page.mjs 生成），这里不含任何业务数据。
for (const root of document.querySelectorAll(".mech")) {
  const { steps, state0 } = JSON.parse(root.dataset.mech);
  const $ = s => root.querySelector(s), $$ = s => [...root.querySelectorAll(s)];
  const say = $(".mech-say"), count = $(".mech-count");
  const playBtn = $('[data-do="play"]');
  let at = 0, timer = null;

  // 第 k 步时的累计状态：角色状态和状态表都是从头逐步叠加出来的，所以"上一步"也能正确回退。
  function snapshot(k) {
    const actors = {}, state = { ...state0 };
    for (const s of steps.slice(0, k)) { Object.assign(actors, s.actors || {}); Object.assign(state, s.state || {}); }
    return { actors, state };
  }

  // 泳道亮暗：常驻角色一直亮；一次性的进程只在运行时亮，未启动或已退出时变暗。
  const OFF = new Set(["", "未启动", "已退出"]);
  const lit = (el, status) => !el.hasAttribute("data-proc") || !OFF.has(status);

  function render(animate) {
    const step = steps[at - 1], prev = snapshot(at - 1), now = snapshot(at);
    for (const el of $$(".lane-head")) {
      const id = el.dataset.actor, status = now.actors[id] || "", on = lit(el, status);
      el.querySelector("small").textContent = status;
      el.classList.toggle("dim", !on);
      el.classList.toggle("changed", at > 0 && (step.actors || {})[id] !== undefined);
      $(`.lifeline[data-actor="${id}"]`).classList.toggle("dim", !on);
    }
    // 已经发生的消息留在泳道上（变淡），当前这一步的消息高亮并播放画线动画。
    for (const row of $$(".msg")) {
      const k = Number(row.dataset.step);
      row.hidden = k > at;
      row.classList.toggle("now", k === at);
      if (k === at && animate) { row.classList.remove("draw"); void row.offsetWidth; row.classList.add("draw"); }
    }
    for (const el of $$(".mech-state > div")) {
      const k = el.dataset.key;
      el.querySelector("dd").textContent = now.state[k];
      el.classList.toggle("changed", at > 0 && prev.state[k] !== now.state[k]);
    }
    for (const li of $$(".mech-code li")) {
      const n = Number(li.dataset.line);
      li.classList.toggle("on", Boolean(step?.lines && n >= step.lines[0] && n <= step.lines[1]));
    }
    const first = $(".mech-code li.on");
    if (first && animate) { const ol = $(".mech-code ol"); ol.scrollTo({ top: first.offsetTop - ol.offsetTop - 40, behavior: "smooth" }); }
    say.textContent = step ? step.say : "点「下一步」开始演示。";
    say.classList.toggle("warn", Boolean(step?.warn));
    count.textContent = `${at} / ${steps.length}`;
    $(".mech-takeaway").hidden = at < steps.length;
    $('[data-do="prev"]').disabled = at === 0;
    $('[data-do="next"]').disabled = at === steps.length;
  }

  function stop() { clearInterval(timer); timer = null; playBtn.textContent = "自动播放"; }
  root.addEventListener("click", event => {
    const action = event.target.closest("[data-do]")?.dataset.do;
    if (!action) return;
    if (action === "play") {
      if (timer) return stop();
      if (at === steps.length) at = 0;
      playBtn.textContent = "暂停";
      const tick = () => { if (at >= steps.length) return stop(); at++; render(true); };
      tick(); timer = setInterval(tick, 2600);
      return;
    }
    stop();
    if (action === "next" && at < steps.length) { at++; render(true); }
    if (action === "prev" && at > 0) { at--; render(true); }
    if (action === "reset") { at = 0; render(false); }
  });
  render(false);
}
