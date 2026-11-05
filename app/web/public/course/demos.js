// 阶段演示页的机制动画：每一步高亮源码行、把一条消息从一个角色送到另一个角色、更新角色状态和右侧状态表。
// 数据写在每个 .mech 的 data-mech 属性里（由 build-changes-page.mjs 生成），这里不含任何业务数据。
for (const root of document.querySelectorAll(".mech")) {
  const { steps, state0 } = JSON.parse(root.dataset.mech);
  const $ = s => root.querySelector(s), $$ = s => [...root.querySelectorAll(s)];
  const stageBox = $(".mech-stage"), packet = $(".mech-packet"), track = $(".mech-track"), say = $(".mech-say"), count = $(".mech-count");
  const playBtn = $('[data-do="play"]');
  let at = 0, timer = null;

  // 第 k 步时的累计状态：角色状态和状态表都是从头逐步叠加出来的，所以"上一步"也能正确回退。
  function snapshot(k) {
    const actors = {}, state = { ...state0 };
    for (const s of steps.slice(0, k)) { Object.assign(actors, s.actors || {}); Object.assign(state, s.state || {}); }
    return { actors, state };
  }

  // 消息走在角色上方的轨道上：从发出方的正上方移动到接收方的正上方，轨道上的箭头标出方向。
  const LANE = 26;
  function centerX(id) {
    const el = $(`[data-actor="${id}"]`), box = stageBox.getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.left - box.left + r.width / 2;
  }
  function place(x) { packet.style.left = `${x}px`; packet.style.top = `${LANE}px`; }

  function fly(flow, warn) {
    packet.hidden = track.hidden = true; packet.className = "mech-packet"; track.className = "mech-track";
    for (const el of $$(".mech-actor")) el.classList.remove("from", "to", "self");
    if (!flow) return;
    const [from, to, label] = flow;
    packet.textContent = label; if (warn) { packet.classList.add("warn"); track.classList.add("warn"); }
    $(`[data-actor="${from}"]`).classList.add("from");
    if (from === to) { $(`[data-actor="${to}"]`).classList.add("self"); place(centerX(to)); packet.hidden = false; packet.classList.add("pop"); return; }
    $(`[data-actor="${to}"]`).classList.add("to");
    const a = centerX(from), b = centerX(to);
    track.style.left = `${Math.min(a, b)}px`; track.style.width = `${Math.abs(b - a)}px`; track.style.top = `${LANE}px`;
    track.classList.add(b > a ? "right" : "left"); track.hidden = false;
    packet.style.transition = "none"; place(a); packet.hidden = false;
    // 先放在起点，下一帧再移动到终点，让过渡动画生效。
    requestAnimationFrame(() => requestAnimationFrame(() => { packet.style.transition = ""; place(b); }));
  }

  function render(animate) {
    const step = steps[at - 1], prev = snapshot(at - 1), now = snapshot(at);
    for (const el of $$(".mech-actor")) {
      const id = el.dataset.actor;
      el.querySelector("small").textContent = now.actors[id] || "";
      el.classList.toggle("changed", at > 0 && (step.actors || {})[id] !== undefined);
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
    if (animate) fly(step?.flow, step?.warn); else fly(null);
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
