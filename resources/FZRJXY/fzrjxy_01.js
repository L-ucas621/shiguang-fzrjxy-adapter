// 福州软件职业技术学院 · 智慧校园信息平台（学生版）课表导入适配脚本
// 站点：https://jw.fzrjxy.com/studentportal.php/
// 原理：在 App 的 WebView 内登录后，同源读取“我的周课表”入口页，取出 1~N 周课表地址，
//       逐周请求并解析服务端渲染的表格，合并成课程数据后提交给拾光课程表。
// 说明：全程不接触账号密码，不处理验证码；登录状态由 WebView 自身的会话维持。
(function () {
  'use strict';

  var ORIGIN = (window.location && window.location.origin) || 'https://jw.fzrjxy.com';
  var ENTRY_PATH = '/studentportal.php/Jxxx/xskbxx/optype/1';
  var CONCURRENCY = 3;

  // 教学作息时间表（2026年10月8日起执行）
  var TIME_SLOTS = [
    { number: 1, startTime: '08:25', endTime: '09:10' },
    { number: 2, startTime: '09:15', endTime: '10:00' },
    { number: 3, startTime: '10:10', endTime: '10:55' },
    { number: 4, startTime: '11:00', endTime: '11:45' },
    { number: 5, startTime: '13:50', endTime: '14:35' },
    { number: 6, startTime: '14:40', endTime: '15:25' },
    { number: 7, startTime: '15:35', endTime: '16:20' },
    { number: 8, startTime: '16:25', endTime: '17:10' },
    { number: 9, startTime: '18:30', endTime: '19:15' },
    { number: 10, startTime: '19:20', endTime: '20:05' },
    { number: 11, startTime: '20:10', endTime: '20:55' },
    { number: 12, startTime: '21:00', endTime: '21:45' }
  ];

  // 错峰教学作息时间表（2026年9月3日—10月7日，第二批 2026级）
  // 只有上午 1~4 节不同，其余节次沿用基础时间，因此只提交差异部分
  var STAGGERED_SLOTS = [
    { number: 1, startTime: '08:45', endTime: '09:30' },
    { number: 2, startTime: '09:35', endTime: '10:20' },
    { number: 3, startTime: '10:30', endTime: '11:15' },
    { number: 4, startTime: '11:20', endTime: '12:05' }
  ];

  var COMBO_SCHEDULE = {
    name: '2026-2027 学年作息方案',
    publicSchedules: [
      {
        name: '错峰作息（9/3-10/7）',
        startDate: '2026-09-03',
        endDate: '2026-10-07',
        timeSlots: STAGGERED_SLOTS
      },
      {
        name: '正常作息（10/8 起）',
        startDate: '2026-10-08',
        endDate: '2027-02-28',
        timeSlots: []
      }
    ]
  };

  function toast(msg) {
    try {
      window.shiguangBridge.showToast(msg);
    } catch (e) {
      console.log('[FZRJXY] ' + msg);
    }
  }

  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function stripTags(s) {
    return decodeEntities(String(s == null ? '' : s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
  }

  // “第1节” → 1；“中午1/中午2” → 0（非标准节次）
  function toSection(label) {
    var m = /第\s*(\d+)\s*节/.exec(String(label || ''));
    return m ? parseInt(m[1], 10) : 0;
  }

  // 读取一个单元格里的课程（可能不止一门）
  function readCourseEntries(inner) {
    var list = [];
    var re = /<div\s+title="([^"]*)"/gi;
    var m;
    while ((m = re.exec(inner))) {
      var parts = decodeEntities(m[1]).split(/\r?\n/).map(function (s) { return s.trim(); });
      var name = parts[0] || '';
      if (!name) continue;
      list.push({
        name: name,
        teacher: parts[1] || '',
        position: parts.slice(2).join(' ')
      });
    }
    return list;
  }

  // 解析某一周的课表页，返回 {dates, monday, courses, skippedLunch}
  function parseWeek(html) {
    var out = { dates: [], monday: '', courses: [], skippedLunch: 0 };
    var table = /<table[\s\S]*?<\/table>/i.exec(html);
    if (!table) return out;

    var trs = [];
    var trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    var m;
    while ((m = trRe.exec(table[0]))) trs.push(m[1]);
    if (!trs.length) return out;

    // 表头里的周一到周日日期
    var dateRe = /星期[一二三四五六日]\s*<br\s*\/?>\s*(\d{4}-\d{2}-\d{2})/gi;
    while ((m = dateRe.exec(trs[0]))) out.dates.push(m[1]);
    out.monday = out.dates[0] || '';

    // 每一行的节次标签
    var labels = [];
    for (var r = 1; r < trs.length; r++) {
      var first = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(trs[r]);
      labels[r] = first ? stripTags(first[1]) : '';
    }

    var occupied = [];
    for (var r2 = 1; r2 < trs.length; r2++) {
      occupied[r2] = occupied[r2] || [];
      var cells = [];
      var tdRe = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
      var c;
      while ((c = tdRe.exec(trs[r2]))) cells.push({ attrs: c[1], inner: c[2] });

      var col = 0;
      for (var i = 0; i < cells.length; i++) {
        while (occupied[r2][col]) col++;
        if (i === 0) { col++; continue; } // 行首是节次标签

        var cell = cells[i];
        var rsMatch = /rowspan="(\d+)"/i.exec(cell.attrs);
        var rs = rsMatch ? Math.max(1, parseInt(rsMatch[1], 10)) : 1;
        for (var k = 0; k < rs && r2 + k < trs.length; k++) {
          occupied[r2 + k] = occupied[r2 + k] || [];
          occupied[r2 + k][col] = true;
        }

        var day = col; // 1=周一 ... 7=周日
        var startSection = toSection(labels[r2]);
        var endSection = toSection(labels[r2 + rs - 1]) || (startSection ? startSection + rs - 1 : 0);
        var entries = readCourseEntries(cell.inner);

        if (entries.length) {
          if (!startSection || day < 1 || day > 7) {
            // 中午1/中午2 等非标准节次，拾光按节次排课无法准确安置，直接跳过
            out.skippedLunch += entries.length;
          } else {
            for (var j = 0; j < entries.length; j++) {
              out.courses.push({
                name: entries[j].name,
                teacher: entries[j].teacher,
                position: entries[j].position,
                day: day,
                startSection: startSection,
                endSection: endSection
              });
            }
          }
        }
        col++;
      }
    }
    return out;
  }

  // 从入口页提取全部周次地址，以及学年/学期
  function extractWeeks(html) {
    var map = {};
    var order = [];
    var re = /\/studentportal\.php\/Jxxx\/xskbxx\/optype\/2\/xn\/([^/'"]+)\/xq\/([^/'"]+)\/dqz\/(\d+)\/sybmdmstr\/([^/'"]+)\/bjmc\/([^'"]+)/g;
    var m;
    var xn = '';
    var xq = '';
    while ((m = re.exec(html))) {
      xn = decodeEntities(m[1]);
      xq = decodeEntities(m[2]);
      var week = parseInt(m[3], 10);
      if (!week || map[week]) continue;
      map[week] = { week: week, path: decodeEntities(m[0]) };
      order.push(week);
    }
    order.sort(function (a, b) { return a - b; });
    return {
      xn: xn,
      xq: xq,
      weeks: order.map(function (w) { return map[w]; })
    };
  }

  // 同名同师同地点同时间跨周合并，weeks 取并集
  function mergeCourses(items) {
    var map = {};
    var keys = [];
    items.forEach(function (it) {
      var key = [it.name, it.teacher, it.position, it.day, it.startSection, it.endSection].join('|');
      if (!map[key]) {
        map[key] = {
          name: it.name,
          teacher: it.teacher,
          position: it.position,
          day: it.day,
          startSection: it.startSection,
          endSection: it.endSection,
          weeks: []
        };
        keys.push(key);
      }
      if (map[key].weeks.indexOf(it.week) < 0) map[key].weeks.push(it.week);
    });
    return keys.map(function (k) {
      map[k].weeks.sort(function (a, b) { return a - b; });
      return map[k];
    });
  }

  function isLoginPage(html) {
    return /id="login-form"/.test(html) || (/学生登录/.test(html) && /请输入验证码/.test(html));
  }

  async function fetchText(path) {
    var res = await fetch(ORIGIN + path, { credentials: 'same-origin', redirect: 'follow' });
    var text = await res.text();
    if (isLoginPage(text)) {
      var err = new Error('LOGIN_REQUIRED');
      err.code = 'LOGIN_REQUIRED';
      throw err;
    }
    return text;
  }

  async function pool(items, limit, fn) {
    var results = new Array(items.length);
    var index = 0;
    var workers = [];
    var n = Math.min(limit, items.length);
    for (var i = 0; i < n; i++) {
      workers.push((async function () {
        while (index < items.length) {
          var cur = index++;
          results[cur] = await fn(items[cur], cur);
        }
      })());
    }
    await Promise.all(workers);
    return results;
  }

  async function run() {
    if (!window.shiguangBridgePromise) {
      throw new Error('请从「拾光课程表 → 教务系统导入」中运行本脚本。');
    }
    if (window.__fzrjxyRunning) return;
    window.__fzrjxyRunning = true;

    toast('正在读取课表入口…');
    var entry;
    try {
      entry = await fetchText(ENTRY_PATH);
    } catch (e) {
      if (e.code === 'LOGIN_REQUIRED') {
        throw new Error('尚未登录或登录已失效，请先在当前页面登录，再点击「执行导入」。');
      }
      throw e;
    }

    var meta = extractWeeks(entry);
    if (!meta.weeks.length) {
      throw new Error('没有找到周课表链接，请确认已登录并停留在学生平台页面。');
    }
    toast('共 ' + meta.weeks.length + ' 个周次，正在逐周读取…');

    var failed = 0;
    var parsed = await pool(meta.weeks, CONCURRENCY, async function (w) {
      try {
        var html = await fetchText(w.path);
        var p = parseWeek(html);
        return { week: w.week, dates: p.dates, monday: p.monday, courses: p.courses, skippedLunch: p.skippedLunch };
      } catch (e) {
        if (e.code === 'LOGIN_REQUIRED') throw e;
        failed++;
        return { week: w.week, dates: [], monday: '', courses: [], skippedLunch: 0 };
      }
    });

    var all = [];
    parsed.forEach(function (p) {
      p.courses.forEach(function (c) {
        all.push({
          name: c.name, teacher: c.teacher, position: c.position,
          day: c.day, startSection: c.startSection, endSection: c.endSection,
          week: p.week
        });
      });
    });
    if (!all.length) {
      throw new Error('没有解析到课程：可能当前学期尚未排课，或登录状态已失效。');
    }

    var courses = mergeCourses(all);
    var maxWeek = 0;
    courses.forEach(function (c) {
      c.weeks.forEach(function (w) { if (w > maxWeek) maxWeek = w; });
    });

    var week1 = null;
    var firstDated = null;
    parsed.forEach(function (p) {
      if (!p.monday) return;
      if (!firstDated) firstDated = p;
      if (p.week === 1) week1 = p;
    });

    var config = {
      firstDayOfWeek: 1,
      semesterTotalWeeks: Math.max(20, maxWeek)
    };
    if (week1 || firstDated) config.semesterStartDate = (week1 || firstDated).monday;

    await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(TIME_SLOTS));
    await window.shiguangBridgePromise.saveComboSchedule(JSON.stringify(COMBO_SCHEDULE));
    await window.shiguangBridgePromise.saveCourseConfig(JSON.stringify(config));
    await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(courses));

    var skipped = parsed.reduce(function (n, p) { return n + (p.skippedLunch || 0); }, 0);
    toast('导入完成：' + courses.length + ' 条课程 / ' + meta.weeks.length + ' 个周次'
      + (failed ? '（' + failed + ' 周读取失败）' : '')
      + (skipped ? '，已跳过 ' + skipped + ' 条午间课程' : ''));
    try { window.shiguangBridge.notifyTaskCompletion(); } catch (e2) { /* ignore */ }
  }

  // 暴露给浏览器调试插件/本地测试
  window.__fzrjxy = {
    run: run,
    parseWeek: parseWeek,
    extractWeeks: extractWeeks,
    mergeCourses: mergeCourses,
    isLoginPage: isLoginPage
  };

  if (window.shiguangBridgePromise) {
    window.__fzrjxyPromise = run().catch(function (err) {
      window.__fzrjxyRunning = false;
      var msg = err && err.message ? err.message : String(err);
      toast('导入失败：' + msg);
      return { error: msg };
    });
  }
})();
