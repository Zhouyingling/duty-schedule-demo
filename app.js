/**
 * 云值守排班日历
 * 班次对齐排班表：早7/8/9、中12、晚14:30–18:30、夜23:30
 */
(function () {
  const DATA = window.SCHEDULE_DATA;
  const TARGET = DATA.meta.targetLoad || 17;
  const STORAGE_KEY = "duty_schedule_v2_" + DATA.meta.weekStart;
  const OLD_KEY = "duty_schedule_v1_" + DATA.meta.weekStart;
  const SHIFT_TIMES_KEY = "duty_shift_times_v1";
  const STAFF_BANDS_KEY = "duty_staff_bands_v1";
  const LEGACY = { early: "early8", late: "late1530", night: "night2330" };
  const DEFAULT_SHIFTS = JSON.parse(JSON.stringify(DATA.shifts));
  const DEFAULT_STAFF_BANDS = Object.fromEntries(DATA.staff.map((p) => [p.id, p.band]));

  let SHIFT_MAP = {};
  const BANDS = ["早", "中", "晚", "晚夜", "夜"];
  const BAND_ORDER = { 早: 0, 晚: 1, 夜: 2 };

  function rebuildShiftIndex() {
    SHIFT_MAP = Object.fromEntries(DATA.shifts.map((s) => [s.id, s]));
  }

  function sortStaff() {
    DATA.staff.sort((a, b) => {
      const da = BAND_ORDER[a.band] ?? 9;
      const db = BAND_ORDER[b.band] ?? 9;
      if (da !== db) return da - db;
      return String(a.name).localeCompare(String(b.name), "zh");
    });
  }

  loadShiftCatalog();
  loadStaffBands();
  sortStaff();
  /** @type {Record<string, Record<string, string|null>>} */
  let schedule = loadSchedule();
  /** @type {Set<string>} */
  let selected = new Set();
  let focusDay = 0;

  function normalizeShift(id) {
    if (!id) return null;
    if (id === "rest") return "rest";
    if (LEGACY[id]) return LEGACY[id];
    return SHIFT_MAP[id] ? id : null;
  }

  function loadSchedule() {
    let saved = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(OLD_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (_) {}
    const out = saved && typeof saved === "object" ? saved : {};
    DATA.staff.forEach((p) => {
      if (!out[p.id]) out[p.id] = {};
      DATA.days.forEach((d) => {
        const cur = out[p.id][d.date];
        out[p.id][d.date] = cur === undefined ? null : normalizeShift(cur);
      });
    });
    return out;
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedule));
  }

  function avgCapacity() {
    const sum = DATA.staff.reduce((s, p) => s + p.capacity, 0);
    return sum / DATA.staff.length;
  }

  function peakRequiredForHours(dayIdx, hours) {
    const req = DATA.days[dayIdx].required;
    let peak = 0;
    hours.forEach((h) => {
      peak = Math.max(peak, req[h] || 0);
    });
    return peak;
  }

  function dayDemandHc(dayIdx) {
    return Math.max(...DATA.days[dayIdx].required);
  }

  /** 按大班（早/中/晚/夜）合并的小时并集 */
  function bandHours(band) {
    const set = new Set();
    DATA.shifts
      .filter((s) => s.band === band || (band === "晚" && s.band === "晚夜"))
      .forEach((s) => s.hours.forEach((h) => set.add(h)));
    return [...set];
  }

  function dayScheduled(dayIdx) {
    const date = DATA.days[dayIdx].date;
    let headcount = 0;
    let capacity = 0;
    const byShift = {};
    const capByShift = {};
    const byBand = {};
    const capByBand = {};
    DATA.shifts.forEach((s) => {
      byShift[s.id] = 0;
      capByShift[s.id] = 0;
    });
    BANDS.forEach((b) => {
      byBand[b] = 0;
      capByBand[b] = 0;
    });

    const supply = new Array(24).fill(0);
    DATA.staff.forEach((p) => {
      const sh = normalizeShift(schedule[p.id]?.[date]);
      if (!sh || !SHIFT_MAP[sh]) return;
      const def = SHIFT_MAP[sh];
      headcount += 1;
      capacity += p.capacity;
      byShift[sh] += 1;
      capByShift[sh] += p.capacity;
      byBand[def.band] = (byBand[def.band] || 0) + 1;
      capByBand[def.band] = (capByBand[def.band] || 0) + p.capacity;
      def.hours.forEach((h) => {
        supply[h] += p.capacity;
      });
    });

    const req = DATA.days[dayIdx].required;
    const pred = DATA.days[dayIdx].pred;
    let worstGapCap = 0;
    let worstH = 0;
    for (let h = 0; h < 24; h++) {
      const gap = req[h] - supply[h];
      if (gap > worstGapCap) {
        worstGapCap = gap;
        worstH = h;
      }
    }

    return {
      headcount,
      capacity: +capacity.toFixed(2),
      byShift,
      capByShift,
      byBand,
      capByBand,
      supply,
      worstGapCap,
      worstH,
      worstGapOrders: Math.round(worstGapCap * TARGET),
      demandHc: dayDemandHc(dayIdx),
      peakPred: Math.max(...pred),
    };
  }

  function adviceForDay(dayIdx) {
    const st = dayScheduled(dayIdx);
    const avgCap = avgCapacity();
    const needMoreCap = Math.max(0, st.worstGapCap);
    const suggestPeople = needMoreCap <= 0 ? 0 : Math.ceil(needMoreCap / avgCap);

    // 按大班给建议（避免 10 个细班次刷屏）
    const bandTips = ["早", "中", "晚", "夜"].map((band) => {
      const hours = bandHours(band);
      const peakReq = peakRequiredForHours(dayIdx, hours);
      let have = st.capByBand[band] || 0;
      if (band === "晚") have += st.capByBand["晚夜"] || 0;
      const gap = Math.max(0, peakReq - have);
      const people = gap <= 0 ? 0 : Math.ceil(gap / avgCap);
      return { band, peakReq, have: +have.toFixed(2), gap: +gap.toFixed(2), people };
    });

    return { st, suggestPeople, needMoreCap, bandTips, avgCap: +avgCap.toFixed(2) };
  }

  function setShift(staffId, date, shiftId) {
    if (!schedule[staffId]) schedule[staffId] = {};
    schedule[staffId][date] = normalizeShift(shiftId);
  }

  /** 计算某日供给相对需求的缺口指标 */
  function gapMetrics(supply, req) {
    let sumGap = 0;
    let maxGap = 0;
    for (let h = 0; h < 24; h++) {
      const g = req[h] - supply[h];
      if (g > 0.05) {
        sumGap += g;
        if (g > maxGap) maxGap = g;
      }
    }
    return { sumGap, maxGap };
  }

  /** 排班表大班段 → 可选细时间段（不跨早/晚/夜） */
  function shiftsForBand(band) {
    if (band === "早") {
      return DATA.shifts.filter((s) => s.band === "早");
    }
    if (band === "晚") {
      // 晚班池：中12 + 晚14:30–18:30（含晚夜）
      return DATA.shifts.filter((s) => s.band === "中" || s.band === "晚" || s.band === "晚夜");
    }
    if (band === "夜") {
      return DATA.shifts.filter((s) => s.band === "夜");
    }
    return DATA.shifts.slice();
  }

  /**
   * 单日缺口最小贪心：只在客服所属早/晚/夜班段内选细时间段；
   * 优先压最紧小时，其次压全天正缺口之和。
   * @param {typeof DATA.staff} [staffPool] 当日可排人员（已排除休息）
   */
  function optimizeDayAssignments(dayIdx, staffPool) {
    const pool = staffPool || DATA.staff;
    const req = DATA.days[dayIdx].required;
    const supply = new Array(24).fill(0);
    const remaining = pool
      .slice()
      .sort((a, b) => b.capacity - a.capacity)
      .map((p) => ({ id: p.id, band: p.band, capacity: p.capacity }));
    const result = {}; // staffId -> shiftId

    function pickBestFor(p, m0) {
      const cands = shiftsForBand(p.band);
      let best = null;
      cands.forEach((shift) => {
        const trial = supply.slice();
        shift.hours.forEach((h) => {
          trial[h] += p.capacity;
        });
        const m = gapMetrics(trial, req);
        const dSum = m0.sumGap - m.sumGap;
        const dMax = m0.maxGap - m.maxGap;
        const score = dMax * 3 + dSum;
        if (!best || score > best.score + 1e-9) {
          best = { shiftId: shift.id, hours: shift.hours, score, dSum, dMax };
        }
      });
      return best;
    }

    while (remaining.length) {
      const m0 = gapMetrics(supply, req);
      if (m0.sumGap < 0.05) break;

      let best = null;
      for (let i = 0; i < remaining.length; i++) {
        const p = remaining[i];
        const pick = pickBestFor(p, m0);
        if (!pick) continue;
        if (!best || pick.score > best.score + 1e-9) {
          best = { i, p, ...pick };
        }
      }

      if (!best || (best.dSum < 0.01 && best.dMax < 0.01)) break;
      best.hours.forEach((h) => {
        supply[h] += best.p.capacity;
      });
      result[best.p.id] = best.shiftId;
      remaining.splice(best.i, 1);
    }

    // 未排上的人：仍只在本人班段内挂到贡献最大的细班次
    remaining.forEach((p) => {
      const m0 = gapMetrics(supply, req);
      const pick = pickBestFor(p, m0);
      if (!pick) return;
      pick.hours.forEach((h) => {
        supply[h] += p.capacity;
      });
      result[p.id] = pick.shiftId;
    });

    return result;
  }

  /** 某班段在某日覆盖小时上的峰值需求 */
  function bandPeakDemand(dayIdx, band) {
    const hours = new Set();
    shiftsForBand(band).forEach((s) => s.hours.forEach((h) => hours.add(h)));
    const req = DATA.days[dayIdx].required;
    let peak = 0;
    hours.forEach((h) => {
      peak = Math.max(peak, req[h] || 0);
    });
    return peak;
  }

  /**
   * 每人每周至少休息 1 天。
   * 同班段内把休息摊开；人效高的优先在需求较低的那天休。
   * @returns {Record<string,string>} staffId -> restDate
   */
  function pickWeeklyRestDays() {
    const restByStaff = {};
    const byBand = { 早: [], 晚: [], 夜: [] };
    DATA.staff.forEach((p) => {
      if (byBand[p.band]) byBand[p.band].push(p);
      else byBand[p.band] = [p];
    });

    Object.keys(byBand).forEach((band) => {
      const people = byBand[band].slice().sort((a, b) => b.capacity - a.capacity);
      const restCount = DATA.days.map(() => 0);
      people.forEach((p) => {
        let bestDay = 0;
        let bestScore = Infinity;
        DATA.days.forEach((_, dayIdx) => {
          // 优先休息人数少的那天，其次该班段需求更低的那天
          const score = restCount[dayIdx] * 100000 + bandPeakDemand(dayIdx, band);
          if (score < bestScore) {
            bestScore = score;
            bestDay = dayIdx;
          }
        });
        restByStaff[p.id] = DATA.days[bestDay].date;
        restCount[bestDay] += 1;
      });
    });
    return restByStaff;
  }

  function autoFillWeek() {
    const restByStaff = pickWeeklyRestDays();
    DATA.days.forEach((d, dayIdx) => {
      const working = DATA.staff.filter((p) => restByStaff[p.id] !== d.date);
      const assign = optimizeDayAssignments(dayIdx, working);
      DATA.staff.forEach((p) => {
        if (restByStaff[p.id] === d.date) setShift(p.id, d.date, "rest");
        else setShift(p.id, d.date, assign[p.id] || null);
      });
    });
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function parseClock(str) {
    const m = String(str || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h, min };
  }

  function formatClock(h, min) {
    return pad2(h) + ":" + pad2(min);
  }

  function clocksFromLabel(label) {
    const m = String(label || "").match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return {
      start: formatClock(Number(m[1]), Number(m[2])),
      end: formatClock(Number(m[3]), Number(m[4])),
    };
  }

  function buildHours(startH, startM, endH, endM) {
    let startMin = startH * 60 + startM;
    let endMin = endH * 60 + endM;
    if (endMin <= startMin) endMin += 24 * 60;
    const first = Math.floor(startMin / 60);
    const endEx = Math.ceil(endMin / 60);
    const hours = [];
    for (let h = first; h < endEx; h++) hours.push(h % 24);
    return hours;
  }

  function applyShiftRange(shift, startStr, endStr) {
    const a = parseClock(startStr);
    const b = parseClock(endStr);
    if (!a || !b) return false;
    if (a.h === b.h && a.min === b.min) return false;
    shift.label = formatClock(a.h, a.min) + "-" + formatClock(b.h, b.min);
    shift.hours = buildHours(a.h, a.min, b.h, b.min);
    shift.start = a.h;
    let endMin = b.h * 60 + b.min;
    const startMin = a.h * 60 + a.min;
    if (endMin <= startMin) endMin += 24 * 60;
    shift.end = Math.ceil(endMin / 60);
    return true;
  }

  function colorForBand(band) {
    if (band === "早") return "#6b9de8";
    if (band === "中") return "#4db8a8";
    if (band === "晚" || band === "晚夜") return "#eba04a";
    return "#9b82e0";
  }

  function newShiftId() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function escapeAttr(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function pruneSchedule() {
    if (!schedule) return;
    DATA.staff.forEach((p) => {
      DATA.days.forEach((d) => {
        const sh = schedule[p.id]?.[d.date];
        if (sh && sh !== "rest" && !SHIFT_MAP[sh]) setShift(p.id, d.date, null);
      });
    });
  }

  function loadShiftCatalog() {
    try {
      const raw = localStorage.getItem(SHIFT_TIMES_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && Array.isArray(saved.shifts) && saved.shifts.length) {
          DATA.shifts = saved.shifts.filter((s) => s && s.id && Array.isArray(s.hours));
        } else if (saved && typeof saved === "object") {
          DATA.shifts.forEach((s) => {
            const row = saved[s.id];
            if (row && row.start && row.end) applyShiftRange(s, row.start, row.end);
          });
        }
      }
    } catch (_) {}
    if (!DATA.shifts.length) DATA.shifts = JSON.parse(JSON.stringify(DEFAULT_SHIFTS));
    rebuildShiftIndex();
  }

  function saveShiftCatalog() {
    localStorage.setItem(SHIFT_TIMES_KEY, JSON.stringify({ shifts: DATA.shifts }));
  }

  function resetShiftCatalog() {
    DATA.shifts = JSON.parse(JSON.stringify(DEFAULT_SHIFTS));
    rebuildShiftIndex();
    pruneSchedule();
    localStorage.removeItem(SHIFT_TIMES_KEY);
  }

  function shiftRowHtml(s) {
    const c = clocksFromLabel(s.label) || { start: "09:00", end: "17:30" };
    const band = s.band === "晚夜" ? "晚" : s.band || "早";
    const name = s.short || s.name || "";
    const opts = ["早", "中", "晚", "夜"]
      .map((b) => `<option value="${b}"${b === band ? " selected" : ""}>${b}</option>`)
      .join("");
    return (
      `<div class="shift-edit-row" data-id="${escapeAttr(s.id || "")}">` +
      `<input type="text" data-role="name" maxlength="8" value="${escapeAttr(name)}" placeholder="名称" />` +
      `<select data-role="band">${opts}</select>` +
      `<input type="time" data-role="start" value="${c.start}" />` +
      `<span class="sep">至</span>` +
      `<input type="time" data-role="end" value="${c.end}" />` +
      `<button type="button" class="del-shift" title="删除">×</button>` +
      `</div>`
    );
  }

  function openShiftModal() {
    document.getElementById("shiftEditList").innerHTML = DATA.shifts.map(shiftRowHtml).join("");
    document.getElementById("shiftModal").hidden = false;
  }

  function closeShiftModal() {
    document.getElementById("shiftModal").hidden = true;
  }

  function addShiftRow() {
    const list = document.getElementById("shiftEditList");
    const wrap = document.createElement("div");
    wrap.innerHTML = shiftRowHtml({ id: "", short: "", band: "早", label: "09:00-17:30" });
    list.appendChild(wrap.firstElementChild);
    const name = list.lastElementChild.querySelector('[data-role="name"]');
    if (name) name.focus();
  }

  function saveShiftModal() {
    const rows = [...document.querySelectorAll("#shiftEditList .shift-edit-row")];
    if (!rows.length) {
      alert("至少保留一个班次。");
      return;
    }
    const next = [];
    const used = new Set();
    for (const row of rows) {
      const start = row.querySelector('[data-role="start"]').value;
      const end = row.querySelector('[data-role="end"]').value;
      const band = row.querySelector('[data-role="band"]').value;
      let name = row.querySelector('[data-role="name"]').value.trim();
      if (!name) {
        const a = parseClock(start);
        name = a ? formatClock(a.h, a.min) : "班次";
      }
      let id = row.dataset.id || newShiftId();
      if (used.has(id)) id = newShiftId();
      const shift = {
        id,
        name,
        short: name,
        band,
        color: colorForBand(band),
      };
      if (!applyShiftRange(shift, start, end)) {
        alert(`「${name}」时间无效，请检查起止时间。`);
        return;
      }
      used.add(id);
      next.push(shift);
    }
    DATA.shifts = next;
    rebuildShiftIndex();
    pruneSchedule();
    saveShiftCatalog();
    closeShiftModal();
    fillSelect();
    renderLegend();
    renderAll();
  }

  function loadStaffBands() {
    try {
      const raw = localStorage.getItem(STAFF_BANDS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;
      DATA.staff.forEach((p) => {
        const b = saved[p.id];
        if (b === "早" || b === "晚" || b === "夜") p.band = b;
      });
    } catch (_) {}
  }

  function saveStaffBands() {
    const out = {};
    DATA.staff.forEach((p) => {
      out[p.id] = p.band;
    });
    localStorage.setItem(STAFF_BANDS_KEY, JSON.stringify(out));
  }

  function pruneShiftsForStaffBands() {
    if (!schedule) return;
    DATA.staff.forEach((p) => {
      const allowed = new Set(shiftsForBand(p.band).map((s) => s.id));
      DATA.days.forEach((d) => {
        const sh = schedule[p.id]?.[d.date];
        if (sh && sh !== "rest" && !allowed.has(sh)) setShift(p.id, d.date, null);
      });
    });
  }

  function resetStaffBands() {
    DATA.staff.forEach((p) => {
      p.band = DEFAULT_STAFF_BANDS[p.id] || p.band;
    });
    sortStaff();
    pruneShiftsForStaffBands();
    localStorage.removeItem(STAFF_BANDS_KEY);
  }

  function staffBandOptions(band) {
    return ["早", "晚", "夜"]
      .map((b) => `<option value="${b}"${b === band ? " selected" : ""}>${b}班</option>`)
      .join("");
  }

  function updateStaffBandCount() {
    const el = document.getElementById("staffBandCount");
    if (!el) return;
    const n = { 早: 0, 晚: 0, 夜: 0 };
    document.querySelectorAll("#staffEditList [data-role='band']").forEach((sel) => {
      if (n[sel.value] != null) n[sel.value] += 1;
    });
    el.textContent = `早 ${n["早"]} · 晚 ${n["晚"]} · 夜 ${n["夜"]}`;
  }

  function openStaffModal() {
    const list = document.getElementById("staffEditList");
    list.innerHTML = DATA.staff
      .map((p) => {
        const band = p.band === "晚夜" ? "晚" : p.band || "早";
        const meta = [p.site, p.group, p.tier].filter(Boolean).join(" · ");
        return (
          `<div class="staff-edit-row" data-id="${escapeAttr(p.id)}" data-text="${escapeAttr((p.name + " " + meta).toLowerCase())}">` +
          `<div><div class="n">${escapeAttr(p.name)}</div><div class="m">${escapeAttr(meta)}</div></div>` +
          `<select data-role="band">${staffBandOptions(band)}</select>` +
          `</div>`
        );
      })
      .join("");
    const filter = document.getElementById("staffFilter");
    filter.value = "";
    updateStaffBandCount();
    document.getElementById("staffModal").hidden = false;
    filter.focus();
  }

  function closeStaffModal() {
    document.getElementById("staffModal").hidden = true;
  }

  function filterStaffRows() {
    const q = document.getElementById("staffFilter").value.trim().toLowerCase();
    document.querySelectorAll("#staffEditList .staff-edit-row").forEach((row) => {
      row.hidden = Boolean(q) && !row.dataset.text.includes(q);
    });
  }

  function saveStaffModal() {
    document.querySelectorAll("#staffEditList .staff-edit-row").forEach((row) => {
      const p = DATA.staff.find((x) => x.id === row.dataset.id);
      if (!p) return;
      const b = row.querySelector('[data-role="band"]').value;
      if (b === "早" || b === "晚" || b === "夜") p.band = b;
    });
    sortStaff();
    pruneShiftsForStaffBands();
    saveStaffBands();
    closeStaffModal();
    renderAll();
  }

  function cellShiftLabel(current) {
    if (!current) return "·";
    if (current === "rest") return "休";
    return SHIFT_MAP[current]?.short || current;
  }

  function cellShiftClass(current) {
    if (!current) return "empty";
    if (current === "rest") return "rest";
    return bandClass(current) || "empty";
  }

  function closeShiftPicker() {
    const picker = document.getElementById("shiftPicker");
    if (!picker) return;
    picker.hidden = true;
    picker.innerHTML = "";
    delete picker.dataset.staff;
    delete picker.dataset.date;
  }

  function openShiftPicker(anchor, staffId, date, current) {
    const picker = document.getElementById("shiftPicker");
    if (!picker) return;
    const items = [
      { value: "", label: "未排", cls: "empty" },
      { value: "rest", label: "休", cls: "rest" },
      ...DATA.shifts.map((s) => ({
        value: s.id,
        label: s.short,
        cls: bandClass(s.id) || "empty",
      })),
    ];
    picker.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="${it.cls}${it.value === (current || "") ? " on" : ""}" data-value="${it.value}">${it.label}</button>`
      )
      .join("");
    picker.dataset.staff = staffId;
    picker.dataset.date = date;
    picker.hidden = false;

    const rect = anchor.getBoundingClientRect();
    const pw = 100;
    const ph = Math.min(320, items.length * 36 + 12);
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 4);
    if (left < 8) left = 8;
    picker.style.left = left + "px";
    picker.style.top = top + "px";
  }

  function keyOf(staffId, date) {
    return staffId + "|" + date;
  }

  function bandClass(shiftId) {
    const b = SHIFT_MAP[shiftId]?.band || "";
    if (b === "早") return "band-early";
    if (b === "中") return "band-mid";
    if (b === "晚" || b === "晚夜") return "band-late";
    if (b === "夜") return "band-night";
    return "";
  }

  function fillSelect() {
    const sel = document.getElementById("fillShift");
    sel.innerHTML = DATA.shifts
      .map((s) => `<option value="${s.id}">${s.name}（${s.label}）</option>`)
      .join("");
    if (DATA.shifts[0]) sel.value = DATA.shifts[0].id;
  }

  function renderLegend() {
    const el = document.getElementById("legend");
    if (!el) return;
    el.innerHTML =
      DATA.shifts
        .map(
          (s) =>
            `<span class="leg"><span class="chip ${bandClass(s.id)}">${s.short}</span> ${s.label}</span>`
        )
        .join("") +
      `<span class="leg"><span class="dot"></span> 未排</span>` +
      `<span class="leg"><span class="chip rest">休</span> 休息</span>` +
      `<button type="button" class="adj-btn" id="adjustShifts" title="增删班次、修改时间段">班次调整</button>` +
      `<button type="button" class="adj-btn" id="adjustStaff" title="指定每位客服早班 / 晚班 / 夜班">人员调整</button>`;
  }

  function renderCal() {
    const table = document.getElementById("cal");
    let head1 =
      '<tr><th class="sticky-name">人员</th>' +
      DATA.days
        .map((d) => {
          const dayNum = d.date.slice(8);
          return `<th>${Number(dayNum)}<br/><span style="font-weight:400">周${d.weekday}</span></th>`;
        })
        .join("") +
      "</tr>";

    let head2 =
      '<tr class="demand"><th class="sticky-name">需求/已排</th>' +
      DATA.days
        .map((_, i) => {
          const st = dayScheduled(i);
          const cls = st.headcount < st.demandHc ? "short" : "ok";
          return `<th class="${cls}">${st.demandHc}/${st.headcount}</th>`;
        })
        .join("") +
      "</tr>";

    let body = "";
    DATA.staff.forEach((p) => {
      body += `<tr><td class="sticky-name"><div class="name">${p.name}</div><div class="meta">${p.dailyAvg || Math.round(p.histEff * 7.5)}单/天 · ${p.histEff}单/时 · 休${p.restQuota}天 · ${p.band}${p.tier ? " · " + p.tier : ""}</div></td>`;
      DATA.days.forEach((d) => {
        const sh = schedule[p.id]?.[d.date] || null;
        const sel = selected.has(keyOf(p.id, d.date)) ? " selected" : "";
        const title = sh === "rest" ? "休息" : SHIFT_MAP[sh]?.label || "未排";
        body +=
          `<td class="cell${sel}" data-staff="${p.id}" data-date="${d.date}">` +
          `<button type="button" class="cell-shift ${cellShiftClass(sh)}" data-staff="${p.id}" data-date="${d.date}" title="${title}">` +
          `${cellShiftLabel(sh)}` +
          `</button></td>`;
      });
      body += "</tr>";
    });

    table.innerHTML = "<thead>" + head1 + head2 + "</thead><tbody>" + body + "</tbody>";
  }

  function renderDayPick() {
    const el = document.getElementById("dayPick");
    el.innerHTML = DATA.days
      .map((d, i) => {
        const on = i === focusDay ? " on" : "";
        return `<button type="button" data-day="${i}" class="${on}">${d.date.slice(5)} 周${d.weekday}</button>`;
      })
      .join("");
  }

  function renderHour() {
    const a = adviceForDay(focusDay);
    const day = DATA.days[focusDay];
    let maxVal = 1;
    for (let h = 0; h < 24; h++) {
      maxVal = Math.max(maxVal, day.required[h], a.st.supply[h]);
    }

    let rows = "";
    for (let h = 0; h < 24; h++) {
      const req = day.required[h];
      const sup = a.st.supply[h];
      const gap = Math.max(0, req - sup);
      const reqPct = (req / maxVal) * 100;
      const supPct = (Math.min(sup, req) / maxVal) * 100;
      const gapStart = (Math.min(sup, req) / maxVal) * 100;
      const gapPct = (gap / maxVal) * 100;
      const short = gap > 0.05;
      const peak = h === a.st.worstH && short;
      const numsCls = short ? "short" : "ok";
      rows += `<div class="hbar${peak ? " peak" : ""}" title="来单 ${day.pred[h]} · 同时峰值(需求) ${req} · 已排 ${sup.toFixed(1)} · 缺口 ${gap.toFixed(1)}">
        <div class="h">${String(h).padStart(2, "0")}</div>
        <div class="track">
          <div class="bar-req" style="width:${reqPct}%"></div>
          <div class="bar-sup" style="width:${supPct}%"></div>
          ${gapPct > 0.2 ? `<div class="bar-gap" style="left:${gapStart}%;width:${gapPct}%"></div>` : ""}
        </div>
        <div class="nums ${numsCls}">${sup.toFixed(0)}/${req}</div>
      </div>`;
    }

    document.getElementById("tabHour").innerHTML = `
      <div class="hour-chart-legend">
        <span><i class="req"></i>需求</span>
        <span><i class="sup"></i>已排</span>
        <span><i class="gap"></i>缺口</span>
        <span>右侧 已排/需求</span>
      </div>
      <div class="hour-chart">${rows}</div>`;
  }

  function renderRoster() {
    const date = DATA.days[focusDay].date;
    const groups = {};
    DATA.shifts.forEach((s) => {
      groups[s.id] = [];
    });
    DATA.staff.forEach((p) => {
      const sh = schedule[p.id]?.[date];
      if (sh && SHIFT_MAP[sh]) groups[sh].push(p);
    });
    const block = (title, list) => {
      if (!list.length) return "";
      return (
        `<div style="margin-bottom:8px"><strong>${title}（${list.length}）</strong>` +
        list
          .map(
            (p) =>
              `<div class="roster-row"><span class="n">${p.name}</span><span class="e">${p.dailyAvg || Math.round(p.histEff * 7.5)}单/天 · 容量 ${p.capacity}</span></div>`
          )
          .join("") +
        "</div>"
      );
    };
    const resting = DATA.staff.filter((p) => schedule[p.id]?.[date] === "rest");
    const unscheduled = DATA.staff.filter((p) => {
      const sh = schedule[p.id]?.[date];
      return !sh;
    });
    let html = DATA.shifts.map((s) => block(`${s.name} ${s.label}`, groups[s.id])).join("");
    html += block("休息", resting);
    html += block("未排", unscheduled);
    document.getElementById("tabRoster").innerHTML = html || `<div class="note">本日尚未排班</div>`;
  }

  function renderEff() {
    const rows = DATA.staff
      .slice()
      .sort((a, b) => b.histEff - a.histEff)
      .map((p) => {
        const recent = (p.histRecent || []).map((r) => `${r.eff}`).join(" · ");
        return `<div class="roster-row">
          <div><div class="n">${p.name}${p.tier ? " · " + p.tier : ""}</div><div class="meta">近7日单/时：${recent || "—"}</div></div>
          <div class="e">${p.dailyAvg || Math.round(p.histEff * 7.5)} 单/天<br/>${p.histEff} 单/时 · 容量 ${p.capacity}</div>
        </div>`;
      })
      .join("");
    document.getElementById("tabEff").innerHTML =
      `<div class="note" style="margin-top:0">日均口径：新人约200–280、常规280–380、熟手380–450 单/天；÷7.5h→单/时；容量 = 人效 ÷ ${TARGET}（对齐 required_limit）。</div>
       <div class="roster-list">${rows}</div>`;
  }

  function renderAll() {
    closeShiftPicker();
    renderCal();
    renderDayPick();
    renderHour();
    renderRoster();
    renderEff();
    save();
  }

  document.getElementById("cal").addEventListener("click", (e) => {
    const btn = e.target.closest("button.cell-shift");
    const cell = e.target.closest(".cell");
    if (!cell) return;
    const staffId = cell.dataset.staff;
    const date = cell.dataset.date;
    const di = DATA.days.findIndex((d) => d.date === date);
    if (di >= 0) focusDay = di;

    if (e.shiftKey || e.metaKey) {
      e.preventDefault();
      closeShiftPicker();
      const k = keyOf(staffId, date);
      if (selected.has(k)) selected.delete(k);
      else selected.add(k);
      renderAll();
      return;
    }

    if (btn) {
      e.stopPropagation();
      const cur = schedule[staffId]?.[date] || null;
      openShiftPicker(btn, staffId, date, cur);
      renderDayPick();
      renderHour();
      renderRoster();
      renderEff();
      return;
    }

    closeShiftPicker();
    renderDayPick();
    renderHour();
    renderRoster();
    renderEff();
  });

  document.getElementById("shiftPicker").addEventListener("click", (e) => {
    const opt = e.target.closest("button[data-value]");
    if (!opt) return;
    const picker = document.getElementById("shiftPicker");
    const staffId = picker.dataset.staff;
    const date = picker.dataset.date;
    if (!staffId || !date) return;
    const val = opt.dataset.value || null;
    setShift(staffId, date, val);
    const di = DATA.days.findIndex((d) => d.date === date);
    if (di >= 0) focusDay = di;
    closeShiftPicker();
    renderAll();
  });

  document.addEventListener("mousedown", (e) => {
    const picker = document.getElementById("shiftPicker");
    if (picker.hidden) return;
    if (e.target.closest("#shiftPicker") || e.target.closest("button.cell-shift")) return;
    closeShiftPicker();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeShiftPicker();
  });

  document.getElementById("cal").addEventListener("contextmenu", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    e.preventDefault();
    closeShiftPicker();
    setShift(cell.dataset.staff, cell.dataset.date, null);
    renderAll();
  });

  document.getElementById("dayPick").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-day]");
    if (!btn) return;
    focusDay = Number(btn.dataset.day);
    renderAll();
  });

  document.getElementById("fillSelected").addEventListener("click", () => {
    const shift = document.getElementById("fillShift").value;
    if (!selected.size) {
      alert("先按住 Shift/⌘ 点选格子，再点填充。");
      return;
    }
    selected.forEach((k) => {
      const [staffId, date] = k.split("|");
      setShift(staffId, date, shift);
    });
    selected.clear();
    renderAll();
  });

  document.getElementById("autoFill").addEventListener("click", () => {
    if (!confirm("将按「缺口最小」重排本周：每人只在所属早/晚/夜班段内排班，且每周至少休息 1 天（覆盖现有排班），继续？")) return;
    const btn = document.getElementById("autoFill");
    btn.disabled = true;
    btn.textContent = "排班中…";
    setTimeout(() => {
      try {
        autoFillWeek();
        selected.clear();
        renderAll();
      } finally {
        btn.disabled = false;
        btn.textContent = "一键排班";
      }
    }, 20);
  });

  document.getElementById("legend").addEventListener("click", (e) => {
    if (e.target.closest("#adjustShifts")) openShiftModal();
    else if (e.target.closest("#adjustStaff")) openStaffModal();
  });

  document.getElementById("shiftCancel").addEventListener("click", closeShiftModal);
  document.getElementById("shiftModal").addEventListener("click", (e) => {
    if (e.target.id === "shiftModal") closeShiftModal();
  });
  document.getElementById("shiftSave").addEventListener("click", saveShiftModal);
  document.getElementById("shiftAdd").addEventListener("click", addShiftRow);
  document.getElementById("shiftEditList").addEventListener("click", (e) => {
    const btn = e.target.closest(".del-shift");
    if (!btn) return;
    const list = document.getElementById("shiftEditList");
    if (list.querySelectorAll(".shift-edit-row").length <= 1) {
      alert("至少保留一个班次。");
      return;
    }
    btn.closest(".shift-edit-row").remove();
  });
  document.getElementById("shiftReset").addEventListener("click", () => {
    if (!confirm("恢复为默认班次时间段？")) return;
    resetShiftCatalog();
    openShiftModal();
    fillSelect();
    renderLegend();
    renderAll();
  });

  document.getElementById("staffCancel").addEventListener("click", closeStaffModal);
  document.getElementById("staffModal").addEventListener("click", (e) => {
    if (e.target.id === "staffModal") closeStaffModal();
  });
  document.getElementById("staffSave").addEventListener("click", saveStaffModal);
  document.getElementById("staffFilter").addEventListener("input", filterStaffRows);
  document.getElementById("staffEditList").addEventListener("change", (e) => {
    if (e.target.matches('[data-role="band"]')) updateStaffBandCount();
  });
  document.getElementById("staffReset").addEventListener("click", () => {
    if (!confirm("恢复为默认人员班段（早/晚/夜）？")) return;
    resetStaffBands();
    openStaffModal();
    renderAll();
  });

  document.getElementById("clearSelected").addEventListener("click", () => {
    selected.forEach((k) => {
      const [staffId, date] = k.split("|");
      setShift(staffId, date, null);
    });
    selected.clear();
    renderAll();
  });

  document.getElementById("clearWeek").addEventListener("click", () => {
    if (!confirm("清空本周全部排班？")) return;
    DATA.staff.forEach((p) => {
      DATA.days.forEach((d) => setShift(p.id, d.date, null));
    });
    selected.clear();
    renderAll();
  });

  document.getElementById("exportJson").addEventListener("click", () => {
    const out = {
      weekStart: DATA.meta.weekStart,
      shifts: DATA.shifts,
      schedule,
      advice: DATA.days.map((_, i) => {
        const a = adviceForDay(i);
        return {
          date: DATA.days[i].date,
          demandHc: a.st.demandHc,
          headcount: a.st.headcount,
          gapOrders: a.st.worstGapOrders,
          suggestPeople: a.suggestPeople,
          byShift: a.st.byShift,
        };
      }),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "duty-schedule-" + DATA.meta.weekStart + ".json";
    a.click();
  });

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b === btn));
    const tab = btn.dataset.tab;
    document.getElementById("tabHour").hidden = tab !== "hour";
    document.getElementById("tabRoster").hidden = tab !== "roster";
    document.getElementById("tabEff").hidden = tab !== "eff";
  });

  (function seedIfEmpty() {
    const any = DATA.staff.some((p) => DATA.days.some((d) => schedule[p.id]?.[d.date]));
    if (any) return;
    const earlyPeople = DATA.staff.filter((p) => p.band === "早").slice(0, 6);
    const latePeople = DATA.staff.filter((p) => p.band === "晚").slice(0, 6);
    const nightPeople = DATA.staff.filter((p) => p.band === "夜").slice(0, 2);
    DATA.days.slice(0, 3).forEach((d, i) => {
      earlyPeople.forEach((p, j) => setShift(p.id, d.date, ["early7", "early8", "early9"][j % 3]));
      latePeople.forEach((p, j) =>
        setShift(p.id, d.date, ["late1530", "late1630", "late1730", "late1830"][j % 4])
      );
      if (i < 2) nightPeople.forEach((p) => setShift(p.id, d.date, "night2330"));
    });
  })();

  fillSelect();
  renderLegend();
  renderAll();
})();
