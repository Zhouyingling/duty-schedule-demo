/**
 * 云值守排班日历
 * 班次对齐排班表：早7/8/9、中12、晚14:30–18:30、夜23:30
 */
(function () {
  const DATA = window.SCHEDULE_DATA;
  const TARGET = DATA.meta.targetLoad || 17;
  const MONTH_KEY = DATA.meta.monthStart || DATA.meta.weekStart;
  const STORAGE_KEY = "duty_schedule_v4_" + MONTH_KEY;
  const OLD_KEYS = [
    "duty_schedule_v3_" + MONTH_KEY,
    "duty_schedule_v2_" + DATA.meta.weekStart,
    "duty_schedule_v1_" + DATA.meta.weekStart,
    "duty_schedule_v2_2026-09-28",
    "duty_schedule_v1_2026-09-28",
  ];
  const SHIFT_TIMES_KEY = "duty_shift_times_v1";
  const STAFF_BANDS_KEY = "duty_staff_bands_v1";
  const STAFF_META_KEY = "duty_staff_meta_v1";
  const LEGACY = { early: "early8", late: "late1530", night: "night2330" };
  const DEFAULT_SHIFTS = JSON.parse(JSON.stringify(DATA.shifts));
  const DEFAULT_STAFF = JSON.parse(JSON.stringify(DATA.staff));
  const DEFAULT_STAFF_BANDS = Object.fromEntries(DEFAULT_STAFF.map((p) => [p.id, p.band]));
  const REST_TARGET_MONTH = 4;
  const WEEKS =
    DATA.weeks && DATA.weeks.length
      ? DATA.weeks
      : [
          {
            id: "w1",
            label: DATA.meta.weekStart,
            start: DATA.days[0].date,
            end: DATA.days[DATA.days.length - 1].date,
            dayIndexes: DATA.days.map((_, i) => i),
          },
        ];

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

  function activeStaff() {
    return DATA.staff.filter((p) => !p.excluded);
  }

  function monthRestTarget() {
    return REST_TARGET_MONTH;
  }

  loadShiftCatalog();
  loadStaffMeta();
  sortStaff();
  /** @type {Record<string, Record<string, string|null>>} */
  let schedule = loadSchedule();
  syncLeaveIntoSchedule();
  /** @type {Set<string>} */
  let selected = new Set();
  let focusDay = Math.max(
    0,
    DATA.days.findIndex((d) => d.date === "2026-09-28")
  );
  if (focusDay < 0) focusDay = 0;
  let staffFilterQ = "";
  let staffSearchOpen = false;
  let openStaffId = null;

  function visibleStaff() {
    const q = staffFilterQ.trim().toLowerCase();
    return activeStaff().filter((p) => {
      if (!q) return true;
      const hay = [p.name, p.site, p.group, p.band, p.tier].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  function isWeekendDay(dayIdx) {
    const w = DATA.days[dayIdx]?.weekday;
    return w === "六" || w === "日";
  }

  function viewDayIndexes() {
    return DATA.days.map((_, i) => i);
  }

  function normalizeShift(id) {
    if (!id) return null;
    if (id === "rest") return "rest";
    if (id === "leave") return "leave";
    if (LEGACY[id]) return LEGACY[id];
    return SHIFT_MAP[id] ? id : null;
  }

  function isWorkShift(id) {
    const sh = normalizeShift(id);
    return Boolean(sh && SHIFT_MAP[sh]);
  }

  function isRestLike(id) {
    const sh = normalizeShift(id);
    return sh === "rest" || sh === "leave";
  }

  function loadSchedule() {
    let saved = null;
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        for (const k of OLD_KEYS) {
          raw = localStorage.getItem(k);
          if (raw) break;
        }
      }
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
    const pool = activeStaff();
    if (!pool.length) return 1;
    const sum = pool.reduce((s, p) => s + p.capacity, 0);
    return sum / pool.length;
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
    activeStaff().forEach((p) => {
      const sh = normalizeShift(schedule[p.id]?.[date]);
      if (!sh || !SHIFT_MAP[sh]) return; // leave / rest 不计产能
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

  /** 班次起止相对当日 0 点的分钟；跨夜则 endMin > 24*60 */
  function shiftMinuteRange(shiftId) {
    const def = SHIFT_MAP[normalizeShift(shiftId)];
    if (!def) return null;
    const c = clocksFromLabel(def.label);
    if (!c) return null;
    const a = parseClock(c.start);
    const b = parseClock(c.end);
    if (!a || !b) return null;
    let startMin = a.h * 60 + a.min;
    let endMin = b.h * 60 + b.min;
    if (endMin <= startMin) endMin += 24 * 60;
    return { startMin, endMin, band: def.band };
  }

  function dayIndexOf(date) {
    return DATA.days.findIndex((d) => d.date === date);
  }

  /** 相邻上班班次衔接检查 */
  function checkShiftTransition(staffId, date, newShiftId) {
    const next = normalizeShift(newShiftId);
    if (!isWorkShift(next)) return {};
    const di = dayIndexOf(date);
    if (di < 0) return {};
    const nextRange = shiftMinuteRange(next);
    if (!nextRange) return {};

    function findNeighbor(dir) {
      for (let i = di + dir; i >= 0 && i < DATA.days.length; i += dir) {
        const d = DATA.days[i].date;
        const sh = normalizeShift(schedule[staffId]?.[d]);
        if (isWorkShift(sh)) return { date: d, dayIdx: i, shiftId: sh, range: shiftMinuteRange(sh) };
        if (sh === null) continue;
        // rest / leave：跳过继续找相邻上班日
      }
      return null;
    }

    const prev = findNeighbor(-1);
    const after = findNeighbor(1);
    let block = "";
    let warn = "";

    function gapHours(earlier, later, dayDelta) {
      // earlier 在 earlierDay，later 在 laterDay；dayDelta = laterDay - earlierDay
      const endAbs = earlier.endMin;
      const startAbs = later.startMin + dayDelta * 24 * 60;
      return (startAbs - endAbs) / 60;
    }

    if (prev && prev.range) {
      const dayDelta = di - prev.dayIdx;
      const gap = gapHours(prev.range, nextRange, dayDelta);
      const prevBand = prev.range.band;
      const nextBand = nextRange.band;
      if ((prevBand === "晚" || prevBand === "晚夜") && nextBand === "夜" && gap < 8) {
        block = "衔接冲突：晚/晚夜后紧接夜班，间隔不足，无法安排。";
      } else if (prevBand === "夜" && nextBand === "早") {
        block = "衔接冲突：夜班后不能排次日早班。";
      } else if (gap <= 8 && !block) {
        warn = `与上一班间隔仅 ${gap.toFixed(1)} 小时（≤8h），休息可能不足。`;
      }
    }

    if (!block && after && after.range) {
      const dayDelta = after.dayIdx - di;
      const gap = gapHours(nextRange, after.range, dayDelta);
      const prevBand = nextRange.band;
      const nextBand = after.range.band;
      if ((prevBand === "晚" || prevBand === "晚夜") && nextBand === "夜" && gap < 8) {
        block = "衔接冲突：晚/晚夜后紧接夜班，间隔不足，无法安排。";
      } else if (prevBand === "夜" && nextBand === "早") {
        block = "衔接冲突：夜班后不能排次日早班。";
      } else if (gap <= 8 && !warn) {
        warn = `与下一班间隔仅 ${gap.toFixed(1)} 小时（≤8h），休息可能不足。`;
      }
    }

    return { block, warn };
  }

  function assignShift(staffId, date, shiftId, opts) {
    opts = opts || {};
    const next = normalizeShift(shiftId);
    if (!opts.skipCheck && isWorkShift(next)) {
      const check = checkShiftTransition(staffId, date, next);
      if (check.block) {
        alert(check.block);
        return false;
      }
      if (check.warn && !confirm(check.warn + "\n仍要继续？")) return false;
    }
    setShift(staffId, date, next);
    return true;
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
      return DATA.shifts.filter((s) => s.band === "中" || s.band === "晚" || s.band === "晚夜");
    }
    if (band === "夜") {
      return DATA.shifts.filter((s) => s.band === "夜");
    }
    return DATA.shifts.slice();
  }

  /**
   * 单日缺口最小贪心：只在客服所属早/晚/夜班段内选细时间段；
   * 优先压最紧小时，其次压全天正缺口之和；偏好子班次有轻微加分。
   */
  function optimizeDayAssignments(dayIdx, staffPool) {
    const pool = staffPool || activeStaff();
    const req = DATA.days[dayIdx].required;
    const supply = new Array(24).fill(0);
    const remaining = pool
      .slice()
      .sort((a, b) => b.capacity - a.capacity)
      .map((p) => ({
        id: p.id,
        band: p.band,
        capacity: p.capacity,
        preferredShift: p.preferredShift || null,
      }));
    const result = {};

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
        let score = dMax * 3 + dSum;
        if (p.preferredShift && shift.id === p.preferredShift) score += 0.35;
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

    remaining.forEach((p) => {
      const m0 = gapMetrics(supply, req);
      const pick = pickBestFor(p, m0);
      if (!pick) return;
      // 偏好班次若贡献不明显变差则采用
      if (p.preferredShift) {
        const pref = SHIFT_MAP[p.preferredShift];
        const allowed = shiftsForBand(p.band).some((s) => s.id === p.preferredShift);
        if (pref && allowed) {
          const trial = supply.slice();
          pref.hours.forEach((h) => {
            trial[h] += p.capacity;
          });
          const mPref = gapMetrics(trial, req);
          const mOpt = gapMetrics(
            (() => {
              const t = supply.slice();
              pick.hours.forEach((h) => {
                t[h] += p.capacity;
              });
              return t;
            })(),
            req
          );
          if (mPref.maxGap <= mOpt.maxGap + 0.3 && mPref.sumGap <= mOpt.sumGap + 0.8) {
            pref.hours.forEach((h) => {
              supply[h] += p.capacity;
            });
            result[p.id] = p.preferredShift;
            return;
          }
        }
      }
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

  function staffLeaveDatesInWeek(p, dayIndexes) {
    const leaveSet = new Set(p.leaveDates || []);
    return dayIndexes.map((i) => DATA.days[i].date).filter((d) => leaveSet.has(d));
  }

  /**
   * 每人每月休息 REST_TARGET_MONTH 天（请假优先计入）。
   * 尽量周末休；周末需求高则改为工作日休。
   * @returns {Record<string, string[]>} staffId -> rest dates（含 leave）
   */
  function pickMonthlyRestDays() {
    const idxs = DATA.days.map((_, i) => i);
    const restByStaff = {};
    const byBand = { 早: [], 晚: [], 夜: [] };
    activeStaff().forEach((p) => {
      if (byBand[p.band]) byBand[p.band].push(p);
      else byBand[p.band] = [p];
    });

    Object.keys(byBand).forEach((band) => {
      const people = byBand[band].slice().sort((a, b) => b.capacity - a.capacity);
      const restCount = Object.fromEntries(idxs.map((i) => [i, 0]));

      people.forEach((p) => {
        const leaveSet = new Set(p.leaveDates || []);
        const forced = idxs.map((i) => DATA.days[i].date).filter((d) => leaveSet.has(d));
        const picked = new Set(forced);
        forced.forEach((date) => {
          const di = dayIndexOf(date);
          if (di >= 0 && restCount[di] != null) restCount[di] += 1;
        });

        const need = Math.max(0, REST_TARGET_MONTH - picked.size);
        for (let n = 0; n < need; n++) {
          let bestDay = null;
          let bestScore = Infinity;
          idxs.forEach((dayIdx) => {
            const date = DATA.days[dayIdx].date;
            if (picked.has(date)) return;
            const demand = bandPeakDemand(dayIdx, band);
            // 周末优先；周末需求高时分数变差，会落到工作日
            const weekendBias = isWeekendDay(dayIdx) ? 0 : 60000;
            const score =
              restCount[dayIdx] * 100000 + weekendBias + demand * (isWeekendDay(dayIdx) ? 40 : 8);
            if (score < bestScore) {
              bestScore = score;
              bestDay = dayIdx;
            }
          });
          if (bestDay == null) break;
          picked.add(DATA.days[bestDay].date);
          restCount[bestDay] += 1;
        }
        restByStaff[p.id] = [...picked];
      });
    });
    return restByStaff;
  }

  function defaultShiftForStaff(p) {
    if (p.preferredShift && SHIFT_MAP[p.preferredShift]) {
      const allowed = shiftsForBand(p.band).some((s) => s.id === p.preferredShift);
      if (allowed) return p.preferredShift;
    }
    const cands = shiftsForBand(p.band);
    return cands[0] ? cands[0].id : null;
  }

  function autoFillDays(dayIndexes, restByStaff) {
    const pool = activeStaff();
    const rests = restByStaff || pickMonthlyRestDays();
    const leaveSets = Object.fromEntries(pool.map((p) => [p.id, new Set(p.leaveDates || [])]));
    const restDates = {};
    pool.forEach((p) => {
      restDates[p.id] = new Set(rests[p.id] || []);
    });

    dayIndexes.forEach((dayIdx) => {
      const d = DATA.days[dayIdx];
      const working = pool.filter((p) => !restDates[p.id].has(d.date));
      const assign = optimizeDayAssignments(dayIdx, working);
      pool.forEach((p) => {
        if (leaveSets[p.id].has(d.date)) setShift(p.id, d.date, "leave");
        else if (restDates[p.id].has(d.date)) setShift(p.id, d.date, "rest");
        else setShift(p.id, d.date, assign[p.id] || defaultShiftForStaff(p));
      });
    });

    DATA.staff.forEach((p) => {
      if (!p.excluded) return;
      dayIndexes.forEach((i) => setShift(p.id, DATA.days[i].date, null));
    });
  }

  function autoFillMonth() {
    const rests = pickMonthlyRestDays();
    autoFillDays(
      DATA.days.map((_, i) => i),
      rests
    );
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

  function newStaffId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
        if (sh && sh !== "rest" && sh !== "leave" && !SHIFT_MAP[sh]) setShift(p.id, d.date, null);
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

  /** 将 MM-DD / 日期片段匹配到 DATA.days 的完整日期 */
  function parseLeaveInput(str) {
    const tokens = String(str || "")
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const out = [];
    const seen = new Set();
    tokens.forEach((tok) => {
      let hit = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) {
        hit = DATA.days.find((d) => d.date === tok);
      } else {
        const mmdd = tok.replace(/^0?(\d{1,2})[-/.]0?(\d{1,2})$/, (_, m, d) => pad2(m) + "-" + pad2(d));
        hit = DATA.days.find((d) => d.date.slice(5) === mmdd);
      }
      if (hit && !seen.has(hit.date)) {
        seen.add(hit.date);
        out.push(hit.date);
      }
    });
    return out;
  }

  function formatLeaveInput(dates) {
    return (dates || []).map((d) => d.slice(5)).join(",");
  }

  function syncLeaveIntoSchedule() {
    DATA.staff.forEach((p) => {
      const leaveSet = new Set(p.leaveDates || []);
      DATA.days.forEach((d) => {
        if (!schedule[p.id]) schedule[p.id] = {};
        if (leaveSet.has(d.date)) {
          schedule[p.id][d.date] = "leave";
        } else if (schedule[p.id][d.date] === "leave") {
          schedule[p.id][d.date] = null;
        }
      });
    });
  }

  function ensureStaffSchedule(p) {
    if (!schedule[p.id]) schedule[p.id] = {};
    DATA.days.forEach((d) => {
      if (schedule[p.id][d.date] === undefined) schedule[p.id][d.date] = null;
    });
  }

  function applyStaffMetaEntry(p, meta) {
    if (!meta || typeof meta !== "object") return;
    if (meta.band === "早" || meta.band === "晚" || meta.band === "夜") p.band = meta.band;
    if (meta.preferredShift) p.preferredShift = meta.preferredShift;
    else p.preferredShift = p.preferredShift || null;
    p.excluded = Boolean(meta.excluded);
    p.leaveDates = Array.isArray(meta.leaveDates) ? meta.leaveDates.slice() : p.leaveDates || [];
    if (meta.custom) {
      p.custom = true;
      if (meta.name) p.name = meta.name;
      if (typeof meta.capacity === "number") p.capacity = meta.capacity;
      if (typeof meta.histEff === "number") p.histEff = meta.histEff;
      if (typeof meta.dailyAvg === "number") p.dailyAvg = meta.dailyAvg;
    }
  }

  function loadStaffMeta() {
    let saved = null;
    try {
      const raw = localStorage.getItem(STAFF_META_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (_) {}

    // 兼容旧版仅班段
    if (!saved) {
      try {
        const raw = localStorage.getItem(STAFF_BANDS_KEY);
        if (raw) {
          const bands = JSON.parse(raw);
          if (bands && typeof bands === "object") {
            saved = {};
            Object.keys(bands).forEach((id) => {
              saved[id] = { band: bands[id] };
            });
          }
        }
      } catch (_) {}
    }

    if (!saved || typeof saved !== "object") {
      DATA.staff.forEach((p) => {
        p.preferredShift = p.preferredShift || null;
        p.excluded = Boolean(p.excluded);
        p.leaveDates = p.leaveDates || [];
      });
      return;
    }

    DATA.staff.forEach((p) => applyStaffMetaEntry(p, saved[p.id]));

    Object.keys(saved).forEach((id) => {
      if (DATA.staff.some((p) => p.id === id)) return;
      const meta = saved[id];
      if (!meta || !meta.custom) return;
      DATA.staff.push({
        id,
        name: meta.name || "新客服",
        band: meta.band === "晚" || meta.band === "夜" ? meta.band : "早",
        site: "",
        group: "自定义",
        restQuota: REST_TARGET_MONTH,
        histEff: meta.histEff || 35,
        capacity: meta.capacity || 2,
        histRecent: [],
        tier: "自定义",
        dailyAvg: meta.dailyAvg || 280,
        custom: true,
        preferredShift: meta.preferredShift || null,
        excluded: Boolean(meta.excluded),
        leaveDates: Array.isArray(meta.leaveDates) ? meta.leaveDates.slice() : [],
      });
    });

    DATA.staff.forEach((p) => {
      p.preferredShift = p.preferredShift || null;
      p.excluded = Boolean(p.excluded);
      p.leaveDates = p.leaveDates || [];
    });
  }

  function saveStaffMeta() {
    const out = {};
    DATA.staff.forEach((p) => {
      out[p.id] = {
        band: p.band,
        preferredShift: p.preferredShift || null,
        excluded: Boolean(p.excluded),
        leaveDates: (p.leaveDates || []).slice(),
      };
      if (p.custom) {
        out[p.id].custom = true;
        out[p.id].name = p.name;
        out[p.id].capacity = p.capacity;
        out[p.id].histEff = p.histEff;
        out[p.id].dailyAvg = p.dailyAvg;
      }
    });
    localStorage.setItem(STAFF_META_KEY, JSON.stringify(out));
    // 同步旧 key，便于回退
    const bands = {};
    DATA.staff.forEach((p) => {
      bands[p.id] = p.band;
    });
    localStorage.setItem(STAFF_BANDS_KEY, JSON.stringify(bands));
  }

  function pruneShiftsForStaffBands() {
    if (!schedule) return;
    DATA.staff.forEach((p) => {
      const allowed = new Set(shiftsForBand(p.band).map((s) => s.id));
      DATA.days.forEach((d) => {
        const sh = schedule[p.id]?.[d.date];
        if (sh && sh !== "rest" && sh !== "leave" && !allowed.has(sh)) setShift(p.id, d.date, null);
      });
    });
  }

  function resetStaffBands() {
    // 去掉自定义人员，恢复默认名单与班段
    DATA.staff = JSON.parse(JSON.stringify(DEFAULT_STAFF));
    DATA.staff.forEach((p) => {
      p.band = DEFAULT_STAFF_BANDS[p.id] || p.band;
      p.preferredShift = null;
      p.excluded = false;
      p.leaveDates = [];
      p.custom = false;
    });
    sortStaff();
    Object.keys(schedule).forEach((id) => {
      if (!DATA.staff.some((p) => p.id === id)) delete schedule[id];
    });
    DATA.staff.forEach(ensureStaffSchedule);
    pruneShiftsForStaffBands();
    localStorage.removeItem(STAFF_META_KEY);
    localStorage.removeItem(STAFF_BANDS_KEY);
    syncLeaveIntoSchedule();
  }

  function staffBandOptions(band) {
    return ["早", "晚", "夜"]
      .map((b) => `<option value="${b}"${b === band ? " selected" : ""}>${b}班</option>`)
      .join("");
  }

  function preferredShiftOptions(p) {
    const band = p.band === "晚夜" ? "晚" : p.band || "早";
    const cands = shiftsForBand(band);
    const cur = p.preferredShift || "";
    return (
      `<option value="">自动</option>` +
      cands
        .map(
          (s) =>
            `<option value="${escapeAttr(s.id)}"${s.id === cur ? " selected" : ""}>${escapeAttr(s.short)}</option>`
        )
        .join("")
    );
  }

  function updateStaffBandCount() {
    const el = document.getElementById("staffBandCount");
    if (!el) return;
    const n = { 早: 0, 晚: 0, 夜: 0 };
    let excluded = 0;
    document.querySelectorAll("#staffEditList .staff-edit-row").forEach((row) => {
      if (row.querySelector('[data-role="excluded"]')?.checked) {
        excluded += 1;
        return;
      }
      const sel = row.querySelector('[data-role="band"]');
      if (sel && n[sel.value] != null) n[sel.value] += 1;
    });
    el.textContent = `早 ${n["早"]} · 晚 ${n["晚"]} · 夜 ${n["夜"]}${excluded ? ` · 不排 ${excluded}` : ""}`;
  }

  function staffRowHtml(p) {
    const band = p.band === "晚夜" ? "晚" : p.band || "早";
    const meta = [p.site, p.group, p.tier].filter(Boolean).join(" · ");
    const del = p.custom
      ? `<button type="button" class="del-staff" title="删除">×</button>`
      : `<span></span>`;
    const nameCell = p.custom
      ? `<input type="text" data-role="name" value="${escapeAttr(p.name)}" />`
      : `<div><div class="n">${escapeAttr(p.name)}</div><div class="m">${escapeAttr(meta)}</div></div>`;
    return (
      `<div class="staff-edit-row${p.excluded ? " excluded" : ""}" data-id="${escapeAttr(p.id)}" data-text="${escapeAttr((p.name + " " + meta).toLowerCase())}">` +
      nameCell +
      `<select data-role="band">${staffBandOptions(band)}</select>` +
      `<select data-role="preferred">${preferredShiftOptions({ ...p, band })}</select>` +
      `<label class="chk"><input type="checkbox" data-role="excluded"${p.excluded ? " checked" : ""} />不排</label>` +
      `<input type="text" class="leave-inp" data-role="leave" placeholder="09-25,10-01" value="${escapeAttr(formatLeaveInput(p.leaveDates))}" />` +
      del +
      `</div>`
    );
  }

  function refreshPreferredOptions(row) {
    const p = DATA.staff.find((x) => x.id === row.dataset.id);
    if (!p) return;
    const band = row.querySelector('[data-role="band"]').value;
    const pref = row.querySelector('[data-role="preferred"]');
    const cur = pref.value;
    pref.innerHTML = preferredShiftOptions({ band, preferredShift: cur });
  }

  function openStaffModal() {
    const list = document.getElementById("staffEditList");
    list.innerHTML = DATA.staff.map(staffRowHtml).join("");
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

  function addCustomStaff() {
    const id = newStaffId();
    const p = {
      id,
      name: "新客服",
      band: "早",
      site: "",
      group: "自定义",
      restQuota: REST_TARGET_MONTH,
      histEff: 35,
      capacity: 2,
      histRecent: [],
      tier: "自定义",
      dailyAvg: 280,
      custom: true,
      preferredShift: null,
      excluded: false,
      leaveDates: [],
    };
    DATA.staff.push(p);
    ensureStaffSchedule(p);
    const list = document.getElementById("staffEditList");
    const wrap = document.createElement("div");
    wrap.innerHTML = staffRowHtml(p);
    list.appendChild(wrap.firstElementChild);
    updateStaffBandCount();
    const nameInp = list.lastElementChild.querySelector('[data-role="name"]');
    if (nameInp) {
      nameInp.focus();
      nameInp.select();
    }
  }

  function saveStaffModal() {
    const rowIds = new Set(
      [...document.querySelectorAll("#staffEditList .staff-edit-row")].map((r) => r.dataset.id)
    );
    document.querySelectorAll("#staffEditList .staff-edit-row").forEach((row) => {
      const p = DATA.staff.find((x) => x.id === row.dataset.id);
      if (!p) return;
      const b = row.querySelector('[data-role="band"]').value;
      if (b === "早" || b === "晚" || b === "夜") p.band = b;
      const pref = row.querySelector('[data-role="preferred"]').value;
      p.preferredShift = pref || null;
      p.excluded = Boolean(row.querySelector('[data-role="excluded"]')?.checked);
      p.leaveDates = parseLeaveInput(row.querySelector('[data-role="leave"]').value);
      const nameInp = row.querySelector('[data-role="name"]');
      if (nameInp && p.custom) p.name = nameInp.value.trim() || p.name;
      if (p.excluded) {
        DATA.days.forEach((d) => setShift(p.id, d.date, null));
      }
    });

    DATA.staff = DATA.staff.filter((p) => rowIds.has(p.id));
    Object.keys(schedule).forEach((id) => {
      if (!DATA.staff.some((p) => p.id === id)) delete schedule[id];
    });

    sortStaff();
    DATA.staff.forEach(ensureStaffSchedule);
    pruneShiftsForStaffBands();
    syncLeaveIntoSchedule();
    saveStaffMeta();
    closeStaffModal();
    renderAll();
  }

  function cellShiftLabel(current) {
    if (!current) return "·";
    if (current === "leave") return "假";
    if (current === "rest") return "休";
    return SHIFT_MAP[current]?.short || current;
  }

  function cellShiftClass(current) {
    if (!current) return "empty";
    if (current === "leave") return "leave";
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
      { value: "leave", label: "假", cls: "leave" },
      { value: "__tiaoxiu__", label: "调休", cls: "swap" },
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
    const ph = Math.min(360, items.length * 36 + 12);
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 4);
    if (left < 8) left = 8;
    picker.style.left = left + "px";
    picker.style.top = top + "px";
  }

  /** 调休：工作↔休息对调，请假日不动 */
  function applyTiaoxiu(staffId, date) {
    const p = DATA.staff.find((x) => x.id === staffId);
    if (!p) return false;
    const cur = normalizeShift(schedule[staffId]?.[date]);
    if (cur === "leave") {
      alert("请假日不能调休，请先取消请假。");
      return false;
    }

    const leaveSet = new Set(p.leaveDates || []);
    const dates = DATA.days.map((d) => d.date);

    if (isWorkShift(cur) || cur === null) {
      // 上班 → 休息：找一个非请假的休息日改上班（优先高需求休息日）
      let best = null;
      dates.forEach((d) => {
        if (d === date || leaveSet.has(d)) return;
        const sh = normalizeShift(schedule[staffId]?.[d]);
        if (sh !== "rest") return;
        const di = dayIndexOf(d);
        const demand = dayDemandHc(di);
        if (!best || demand > best.demand) best = { date: d, demand };
      });
      if (!best) {
        alert("没有可对调的休息日（非请假）。");
        return false;
      }
      const workShift = isWorkShift(cur) ? cur : defaultShiftForStaff(p);
      if (!assignShift(staffId, best.date, workShift)) return false;
      setShift(staffId, date, "rest");
      return true;
    }

    if (cur === "rest") {
      // 休息 → 上班：找一个上班日改休息（优先低需求日）
      let best = null;
      dates.forEach((d) => {
        if (d === date || leaveSet.has(d)) return;
        const sh = normalizeShift(schedule[staffId]?.[d]);
        if (!isWorkShift(sh)) return;
        const di = dayIndexOf(d);
        const demand = dayDemandHc(di);
        if (!best || demand < best.demand) best = { date: d, demand, shift: sh };
      });
      if (!best) {
        alert("没有可对调的上班日。");
        return false;
      }
      const workShift = defaultShiftForStaff(p);
      if (!assignShift(staffId, date, workShift)) return false;
      setShift(staffId, best.date, "rest");
      return true;
    }

    return false;
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
      `<span class="leg"><span class="chip leave">假</span> 请假</span>` +
      `<button type="button" class="adj-btn" id="adjustShifts" title="增删班次、修改时间段">班次调整</button>` +
      `<button type="button" class="adj-btn" id="adjustStaff" title="班段 / 子班次 / 请假 / 不排">人员调整</button>`;
  }

  function monthRestCount(p) {
    let n = 0;
    DATA.days.forEach((d) => {
      const sh = normalizeShift(schedule[p.id]?.[d.date]);
      if (sh === "rest" || sh === "leave") n += 1;
    });
    return n;
  }

  function closeStaffPop() {
    openStaffId = null;
    const pop = document.getElementById("staffPop");
    if (pop) {
      pop.hidden = true;
      pop.innerHTML = "";
    }
  }

  function openStaffPop(staffId, anchor) {
    const p = DATA.staff.find((x) => x.id === staffId);
    const pop = document.getElementById("staffPop");
    if (!p || !pop) return;
    openStaffId = staffId;
    const date = DATA.days[focusDay]?.date;
    const sh = schedule[p.id]?.[date] || null;
    const shiftOpts =
      `<option value="">未排</option><option value="rest"${sh === "rest" ? " selected" : ""}>休</option>` +
      `<option value="leave"${sh === "leave" ? " selected" : ""}>假</option>` +
      shiftsForBand(p.band)
        .map(
          (s) =>
            `<option value="${s.id}"${sh === s.id ? " selected" : ""}>${s.short} ${s.label}</option>`
        )
        .join("");
    const prefOpts =
      `<option value="">默认</option>` +
      shiftsForBand(p.band)
        .map(
          (s) =>
            `<option value="${s.id}"${p.preferredShift === s.id ? " selected" : ""}>${s.short}</option>`
        )
        .join("");
    pop.innerHTML =
      `<div class="t">${escapeAttr(p.name)}</div>` +
      `<div class="row">${p.dailyAvg || Math.round(p.histEff * 7.5)} 单/天 · ${p.histEff} 单/时 · 容量 ${p.capacity}</div>` +
      `<div class="row">${p.band}班${p.tier ? " · " + p.tier : ""}${p.site ? " · " + p.site : ""}${p.group ? " · " + p.group : ""}</div>` +
      `<div class="row">今日（${date ? date.slice(5) : "—"}）班次</div>` +
      `<select data-role="today">${shiftOpts}</select>` +
      `<div class="row">偏好子班次</div>` +
      `<select data-role="pref">${prefOpts}</select>` +
      `<div class="acts">` +
      `<button type="button" class="primary" data-act="apply">应用今日班次</button>` +
      `<button type="button" data-act="close">关闭</button>` +
      `</div>`;
    pop.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const w = 240;
    let left = rect.right + 8;
    let top = rect.top;
    if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - w - 8);
    if (top + 260 > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 268);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function renderCal() {
    const table = document.getElementById("cal");
    const idxs = viewDayIndexes();
    const target = monthRestTarget();
    const searchOn = staffSearchOpen || staffFilterQ ? " on" : "";
    let head1 =
      '<tr><th class="sticky-name"><div class="name-head"><span>人员</span>' +
      `<button type="button" class="name-search-btn${searchOn}" id="staffSearchBtn" title="搜索客服">⌕</button></div>` +
      (staffSearchOpen || staffFilterQ
        ? `<input type="search" class="name-filter" id="staffNameFilter" placeholder="搜索姓名…" value="${escapeAttr(staffFilterQ)}" />`
        : "") +
      "</th>" +
      idxs
        .map((i) => {
          const d = DATA.days[i];
          const dayNum = d.date.slice(8);
          return `<th>${Number(dayNum)}<br/><span style="font-weight:400">周${d.weekday}</span></th>`;
        })
        .join("") +
      `<th class="sticky-rest">月休</th></tr>`;

    let head2 =
      '<tr class="demand"><th class="sticky-name">需求/已排</th>' +
      idxs
        .map((i) => {
          const st = dayScheduled(i);
          const cls = st.headcount < st.demandHc ? "short" : "ok";
          return `<th class="${cls}">${st.demandHc}/${st.headcount}</th>`;
        })
        .join("") +
      `<th class="sticky-rest">目标${target}</th></tr>`;

    let body = "";
    visibleStaff().forEach((p) => {
      const restN = monthRestCount(p);
      const restCls = restN < target ? "short" : "ok";
      const open = openStaffId === p.id ? " open" : "";
      body +=
        `<tr><td class="sticky-name${open}">` +
        `<button type="button" class="name-btn" data-staff="${p.id}" title="查看人效并调整班次">${escapeAttr(p.name)}</button>` +
        `</td>`;
      idxs.forEach((i) => {
        const d = DATA.days[i];
        const sh = schedule[p.id]?.[d.date] || null;
        const sel = selected.has(keyOf(p.id, d.date)) ? " selected" : "";
        const title =
          sh === "leave" ? "请假" : sh === "rest" ? "休息" : SHIFT_MAP[sh]?.label || "未排";
        body +=
          `<td class="cell${sel}" data-staff="${p.id}" data-date="${d.date}">` +
          `<button type="button" class="cell-shift ${cellShiftClass(sh)}" data-staff="${p.id}" data-date="${d.date}" title="${title}">` +
          `${cellShiftLabel(sh)}` +
          `</button></td>`;
      });
      body += `<td class="sticky-rest ${restCls}">${restN}/${target}</td></tr>`;
    });

    table.innerHTML = "<thead>" + head1 + head2 + "</thead><tbody>" + body + "</tbody>";
    const filter = document.getElementById("staffNameFilter");
    if (filter && staffSearchOpen) {
      filter.focus();
      const len = filter.value.length;
      try {
        filter.setSelectionRange(len, len);
      } catch (_) {}
    }
  }

  function renderMonthCal() {
    const el = document.getElementById("monthCal");
    const title = document.getElementById("monthTitle");
    if (!el) return;
    if (title) {
      const a = DATA.days[0]?.date?.slice(5) || "";
      const b = DATA.days[DATA.days.length - 1]?.date?.slice(5) || "";
      title.textContent = `${a} ～ ${b}`;
    }

    // 以周一为一周起点：weekday 一=0 … 日=6
    const wdMap = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6 };
    const firstWd = wdMap[DATA.days[0].weekday] ?? 0;
    let html = ["一", "二", "三", "四", "五", "六", "日"].map((w) => `<div class="hd">${w}</div>`).join("");
    for (let i = 0; i < firstWd; i++) html += `<div></div>`;

    DATA.days.forEach((d, i) => {
      const st = dayScheduled(i);
      const on = i === focusDay ? " on" : "";
      const short = st.headcount < st.demandHc ? " short" : "";
      html +=
        `<button type="button" data-day="${i}" class="${on}${short}">` +
        `<span class="d">${Number(d.date.slice(8))}</span>` +
        `<span class="r">${st.demandHc}/${st.headcount}</span>` +
        `</button>`;
    });
    el.innerHTML = html;
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
    const pool = activeStaff();
    pool.forEach((p) => {
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
    const resting = pool.filter((p) => schedule[p.id]?.[date] === "rest");
    const leaving = pool.filter((p) => schedule[p.id]?.[date] === "leave");
    const unscheduled = pool.filter((p) => {
      const sh = schedule[p.id]?.[date];
      return !sh;
    });
    let html = DATA.shifts.map((s) => block(`${s.name} ${s.label}`, groups[s.id])).join("");
    html += block("休息", resting);
    html += block("请假", leaving);
    html += block("未排", unscheduled);
    document.getElementById("tabRoster").innerHTML = html || `<div class="note">本日尚未排班</div>`;
  }

  function renderEff() {
    const rows = activeStaff()
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
    renderMonthCal();
    renderHour();
    renderRoster();
    renderEff();
    save();
    if (openStaffId) {
      const btn = document.querySelector(`.name-btn[data-staff="${openStaffId}"]`);
      if (btn) openStaffPop(openStaffId, btn);
      else closeStaffPop();
    }
  }

  document.getElementById("cal").addEventListener("click", (e) => {
    const searchBtn = e.target.closest("#staffSearchBtn");
    if (searchBtn) {
      e.stopPropagation();
      staffSearchOpen = !staffSearchOpen;
      if (!staffSearchOpen) staffFilterQ = "";
      renderCal();
      return;
    }

    const nameBtn = e.target.closest("button.name-btn");
    if (nameBtn) {
      e.stopPropagation();
      closeShiftPicker();
      const id = nameBtn.dataset.staff;
      if (openStaffId === id) closeStaffPop();
      else openStaffPop(id, nameBtn);
      renderCal();
      if (openStaffId) {
        const btn = document.querySelector(`.name-btn[data-staff="${openStaffId}"]`);
        if (btn) openStaffPop(openStaffId, btn);
      }
      return;
    }

    if (e.target.closest("#staffNameFilter")) return;

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
      closeStaffPop();
      const k = keyOf(staffId, date);
      if (selected.has(k)) selected.delete(k);
      else selected.add(k);
      renderAll();
      return;
    }

    if (btn) {
      e.stopPropagation();
      closeStaffPop();
      const cur = schedule[staffId]?.[date] || null;
      openShiftPicker(btn, staffId, date, cur);
      renderMonthCal();
      renderHour();
      renderRoster();
      renderEff();
      return;
    }

    closeShiftPicker();
    closeStaffPop();
    renderMonthCal();
    renderHour();
    renderRoster();
    renderEff();
  });

  document.getElementById("cal").addEventListener("input", (e) => {
    if (e.target.id !== "staffNameFilter") return;
    staffFilterQ = e.target.value;
    staffSearchOpen = true;
    renderCal();
  });

  document.getElementById("staffPop").addEventListener("click", (e) => {
    const act = e.target.closest("button[data-act]");
    if (!act || !openStaffId) return;
    if (act.dataset.act === "close") {
      closeStaffPop();
      renderCal();
      return;
    }
    if (act.dataset.act === "apply") {
      const pop = document.getElementById("staffPop");
      const today = pop.querySelector('[data-role="today"]').value || null;
      const pref = pop.querySelector('[data-role="pref"]').value || "";
      const p = DATA.staff.find((x) => x.id === openStaffId);
      if (p) {
        p.preferredShift = pref || null;
        saveStaffMeta();
      }
      const date = DATA.days[focusDay]?.date;
      if (date) {
        if (today === "leave") {
          if (p) {
            const set = new Set(p.leaveDates || []);
            set.add(date);
            p.leaveDates = [...set];
            saveStaffMeta();
          }
          setShift(openStaffId, date, "leave");
        } else {
          if (p && (p.leaveDates || []).includes(date)) {
            p.leaveDates = p.leaveDates.filter((d) => d !== date);
            saveStaffMeta();
          }
          if (!assignShift(openStaffId, date, today)) return;
        }
      }
      renderAll();
    }
  });

  document.getElementById("staffPop").addEventListener("change", (e) => {
    if (!e.target.matches('[data-role="pref"]') || !openStaffId) return;
    const p = DATA.staff.find((x) => x.id === openStaffId);
    if (!p) return;
    p.preferredShift = e.target.value || null;
    saveStaffMeta();
  });

  document.getElementById("shiftPicker").addEventListener("click", (e) => {
    const opt = e.target.closest("button[data-value]");
    if (!opt) return;
    const picker = document.getElementById("shiftPicker");
    const staffId = picker.dataset.staff;
    const date = picker.dataset.date;
    if (!staffId || !date) return;
    const val = opt.dataset.value || null;

    if (val === "__tiaoxiu__") {
      applyTiaoxiu(staffId, date);
      closeShiftPicker();
      renderAll();
      return;
    }

    if (val === "leave") {
      const p = DATA.staff.find((x) => x.id === staffId);
      if (p) {
        const set = new Set(p.leaveDates || []);
        set.add(date);
        p.leaveDates = [...set];
        saveStaffMeta();
      }
      setShift(staffId, date, "leave");
    } else {
      if (val === "rest" || !val) {
        const p = DATA.staff.find((x) => x.id === staffId);
        if (p && (p.leaveDates || []).includes(date)) {
          p.leaveDates = p.leaveDates.filter((d) => d !== date);
          saveStaffMeta();
        }
      }
      if (!assignShift(staffId, date, val || null)) return;
    }

    const di = DATA.days.findIndex((d) => d.date === date);
    if (di >= 0) focusDay = di;
    closeShiftPicker();
    renderAll();
  });

  document.addEventListener("mousedown", (e) => {
    const picker = document.getElementById("shiftPicker");
    if (!picker.hidden) {
      if (!e.target.closest("#shiftPicker") && !e.target.closest("button.cell-shift")) {
        closeShiftPicker();
      }
    }
    const pop = document.getElementById("staffPop");
    if (pop && !pop.hidden) {
      if (
        !e.target.closest("#staffPop") &&
        !e.target.closest("button.name-btn") &&
        !e.target.closest("#staffSearchBtn") &&
        !e.target.closest("#staffNameFilter")
      ) {
        closeStaffPop();
        renderCal();
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeShiftPicker();
      closeStaffPop();
      renderCal();
    }
  });

  document.getElementById("cal").addEventListener("contextmenu", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    e.preventDefault();
    closeShiftPicker();
    const staffId = cell.dataset.staff;
    const date = cell.dataset.date;
    const p = DATA.staff.find((x) => x.id === staffId);
    if (p && (p.leaveDates || []).includes(date)) {
      p.leaveDates = p.leaveDates.filter((d) => d !== date);
      saveStaffMeta();
    }
    setShift(staffId, date, null);
    renderAll();
  });

  document.getElementById("monthCal").addEventListener("click", (e) => {
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
      assignShift(staffId, date, shift);
    });
    selected.clear();
    renderAll();
  });

  document.getElementById("autoFillMonth").addEventListener("click", () => {
    if (
      !confirm(
        `将重排整月：每人月休 ${REST_TARGET_MONTH} 天（尽量周末休），尊重请假与不排人员，覆盖现有排班，继续？`
      )
    )
      return;
    const btn = document.getElementById("autoFillMonth");
    btn.disabled = true;
    btn.textContent = "排班中…";
    setTimeout(() => {
      try {
        autoFillMonth();
        selected.clear();
        renderAll();
      } finally {
        btn.disabled = false;
        btn.textContent = "整月排班";
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
  document.getElementById("staffAdd").addEventListener("click", addCustomStaff);
  document.getElementById("staffEditList").addEventListener("change", (e) => {
    const row = e.target.closest(".staff-edit-row");
    if (!row) return;
    if (e.target.matches('[data-role="band"]')) {
      refreshPreferredOptions(row);
      updateStaffBandCount();
    }
    if (e.target.matches('[data-role="excluded"]')) {
      row.classList.toggle("excluded", e.target.checked);
      updateStaffBandCount();
    }
  });
  document.getElementById("staffEditList").addEventListener("click", (e) => {
    const btn = e.target.closest(".del-staff");
    if (!btn) return;
    const row = btn.closest(".staff-edit-row");
    if (row) row.remove();
    updateStaffBandCount();
  });
  document.getElementById("staffReset").addEventListener("click", () => {
    if (!confirm("恢复为默认人员（班段/请假/不排/自定义将清空）？")) return;
    resetStaffBands();
    openStaffModal();
    renderAll();
  });

  document.getElementById("clearSelected").addEventListener("click", () => {
    selected.forEach((k) => {
      const [staffId, date] = k.split("|");
      const p = DATA.staff.find((x) => x.id === staffId);
      if (p && (p.leaveDates || []).includes(date)) {
        p.leaveDates = p.leaveDates.filter((d) => d !== date);
        saveStaffMeta();
      }
      setShift(staffId, date, null);
    });
    selected.clear();
    renderAll();
  });

  document.getElementById("clearMonth").addEventListener("click", () => {
    if (!confirm("清空整月全部排班？（请假标记保留在人员设置中，格子将同步为假）")) return;
    DATA.staff.forEach((p) => {
      DATA.days.forEach((d) => setShift(p.id, d.date, null));
    });
    syncLeaveIntoSchedule();
    selected.clear();
    renderAll();
  });

  document.getElementById("exportJson").addEventListener("click", () => {
    const out = {
      monthStart: DATA.meta.monthStart || DATA.meta.weekStart,
      monthEnd: DATA.meta.monthEnd,
      weeks: WEEKS,
      shifts: DATA.shifts,
      staffMeta: Object.fromEntries(
        DATA.staff.map((p) => [
          p.id,
          {
            name: p.name,
            band: p.band,
            preferredShift: p.preferredShift || null,
            excluded: Boolean(p.excluded),
            leaveDates: (p.leaveDates || []).slice(),
            custom: Boolean(p.custom),
          },
        ])
      ),
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
    a.download = "duty-schedule-" + (DATA.meta.monthStart || DATA.meta.weekStart) + ".json";
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
    // 整月默认留空，由「整月排班」生成
  })();

  fillSelect();
  renderLegend();
  renderAll();
})();
