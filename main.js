const { Plugin, ItemView, Setting, PluginSettingTab, Modal, Notice, normalizePath } = require('obsidian');

// 全局变量，用于存储lunar.js的导出对象
let Lunar, Solar, HolidayUtil;

const VIEW_TYPE_CALENDAR = 'note-calendar-view';

/**
 * 防抖：在连续触发结束 ms 毫秒后才执行 fn
 */
function debounce(fn, ms = 400) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}

/**
 * 判断 filePath 是否位于 folderPath 文件夹下
 * 用 path === folder 或 path.startsWith(folder + '/') 替代朴素 startsWith，
 * 避免 "日记" 误匹配 "日记本/x.md"。路径均先经 normalizePath 标准化。
 */
function isPathInFolder(filePath, folderPath) {
  if (!folderPath) return true;
  const f = normalizePath(folderPath);
  const p = normalizePath(filePath);
  return p === f || p.startsWith(f + '/');
}

/**
 * 节假日数据补全
 * lunar.js 内置的 HolidayUtil 数据仅覆盖到 2026-10。
 * 此处通过 HolidayUtil.fix() 追加 2027 年的法定节日数据，
 * 使 2027 年起日历仍能显示节日标记。
 *
 * 数据格式（每条 18 字符）：YYYYMMDD + 名称索引 + 休/班标志 + 目标日期YYYYMMDD
 *   名称索引: 0=元旦节 1=春节 2=清明节 3=劳动节 4=端午节 5=中秋节 6=国庆节
 *   休/班标志: 1=放假(休) 0=调休上班(班)
 *   目标日期: 该日归属的节日首日
 *
 * 注意：仅标记节日当天为"休"。连休天数与调休班日需待国务院公布
 * 具体安排后才能确定，不预填以免误导（如 2027 清明为周一，与前后
 * 周末自然连休，无需也不能额外标记 4/6、4/7）。
 */
const HOLIDAY_FIX_DATA = (() => {
  // 生成单条记录：仅节日当天放假
  const rec = (date, nameIdx) => date + nameIdx + '1' + date;
  return [
    rec('20270101', '0'), // 元旦节 1/1(周五)
    rec('20270206', '1'), // 春节(正月初一) 2/6(周六)
    rec('20270405', '2'), // 清明节 4/5(周一)
    rec('20270501', '3'), // 劳动节 5/1(周六)
    rec('20270609', '4'), // 端午节 6/9(周三)
    rec('20270915', '5'), // 中秋节 9/15(周三)
    rec('20271001', '6')  // 国庆节 10/1(周五)
  ].join('');
})();

/**
 * 香港公众假期表：日期字符串 -> 假期名称
 * 数据来源：香港政府宪报公告（gov.hk/tc/about/abouthk/holiday）
 * 与大陆节假日独立维护，由"显示香港公众假期"开关控制。
 * 香港假期均为放假（无调休上班），标记一律为"休"。
 * 每年港府公布次年安排后在此追加。
 */
const HK_HOLIDAYS = {
  // 2026 年剩余（宪报已公布）
  '2026-10-19': '重阳节翌日',
  '2026-12-25': '圣诞节',
  '2026-12-26': '圣诞节后第一个周日',
  // 2027 年（2026-05-15 宪报公布）
  '2027-01-01': '一月一日',
  '2027-02-06': '农历年初一',
  '2027-02-08': '农历年初三',
  '2027-02-09': '农历年初四',
  '2027-03-26': '耶稣受难节',
  '2027-03-27': '耶稣受难节翌日',
  '2027-03-29': '复活节星期一',
  '2027-04-05': '清明节',
  '2027-05-01': '劳动节',
  '2027-05-13': '佛诞',
  '2027-06-09': '端午节',
  '2027-07-01': '香港特区成立纪念日',
  '2027-09-16': '中秋节翌日',
  '2027-10-01': '国庆日',
  '2027-10-08': '重阳节',
  '2027-12-25': '圣诞节',
  '2027-12-26': '圣诞节后第一个周日'
};

// 默认设置
const DEFAULT_SETTINGS = {
  startOfWeek: 0, // 0=周日, 1=周一
  weekendColor: '#840606', // 周六周日的颜色，默认为 RGB(132, 6, 6)
  themeColor: '#5d4ed8', // 主题颜色，默认为紫色
  bgColor: '#ffffff', // 背景颜色，默认为白色
  showLunarDate: true, // 是否显示农历日期
  showSolarFestivals: true, // 是否显示阳历节日
  showLunarFestivals: true, // 是否显示农历节日
  showHolidayMarker: true, // 是否显示调休
  showJieQi: true, // 是否显示节气
  showHongKongHolidays: false, // 是否显示香港公众假期
  noteFolderPath: '', // 笔记文件夹路径，默认为空（根目录）
  dateFormat: 'YYYY-MM-DD', // 日期格式，默认为YYYY-MM-DD
  templatePath: '', // 日记模板文件路径，留空则尝试读取核心"日记"插件的模板设置
  defaultCreateFolder: '', // 创建笔记时的默认文件夹路径，留空为根目录
  fontFamily: 'default', // 字体：默认、微软雅黑、宋体、黑体、Arial、Helvetica、Verdana、Tahoma、Segoe UI
  fontSize: 14 // 字号：10-20px，默认14px
};

/**
 * 日历数据模型
 */
class CalendarModel {
  constructor(settings = {}) {
    this.currentDate = new Date();
    this.viewYear = this.currentDate.getFullYear();
    this.viewMonth = this.currentDate.getMonth() + 1; // 1-12
    this.startOfWeek = settings.startOfWeek || 0; // 0=周日, 1=周一
    this.weekendColor = settings.weekendColor || '#999999'; // 周六周日颜色
    this.themeColor = settings.themeColor || '#5d4ed8'; // 主题颜色
    this.bgColor = settings.bgColor || '#ffffff'; // 背景颜色
    this.showLunarDate = settings.showLunarDate !== undefined ? settings.showLunarDate : true; // 是否显示农历日期
    this.showSolarFestivals = settings.showSolarFestivals !== undefined ? settings.showSolarFestivals : true; // 是否显示阳历节日
    this.showLunarFestivals = settings.showLunarFestivals !== undefined ? settings.showLunarFestivals : true; // 是否显示农历节日
    this.showHolidayMarker = settings.showHolidayMarker !== undefined ? settings.showHolidayMarker : true; // 是否显示调休
    this.showJieQi = settings.showJieQi !== undefined ? settings.showJieQi : true; // 是否显示节气
    this.showHongKongHolidays = settings.showHongKongHolidays !== undefined ? settings.showHongKongHolidays : false; // 是否显示香港公众假期
    this.noteFolderPath = settings.noteFolderPath || ''; // 笔记文件夹路径
    this.dateFormat = settings.dateFormat || 'YYYY-MM-DD'; // 日期格式
    this.templatePath = settings.templatePath || ''; // 模板文件路径
    this.defaultCreateFolder = settings.defaultCreateFolder || ''; // 创建笔记默认文件夹路径
    this.fontFamily = settings.fontFamily || 'default'; // 字体
    this.fontSize = settings.fontSize || 14; // 字号
    // 初始化时默认选中今天
    const today = new Date();
    this.selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    this.selectedDate.setHours(0, 0, 0, 0);
    // 笔记缓存：按日期存储笔记信息
    this.noteCache = {};
    // 反向文件索引：path -> {path, title, ctime, mtime}
    // 用于文件事件触发时的增量更新，避免每次都全库重扫
    this.fileIndex = new Map();
  }

  /**
   * 更新周末颜色
   */
  setWeekendColor(color) {
    this.weekendColor = color;
  }

  /**
   * 更新主题颜色
   */
  setThemeColor(color) {
    this.themeColor = color;
  }

  /**
   * 格式化日期为YYYY-MM-DD
   */
  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * 获取指定日期的笔记列表
   */
  getNotesForDate(dateStr) {
    return this.noteCache[dateStr] || [];
  }

  /**
   * 检查指定日期是否有笔记
   */
  hasNotesForDate(dateStr) {
    return this.noteCache[dateStr] && this.noteCache[dateStr].length > 0;
  }

  /**
   * 从所有日期的 noteCache 中移除指定路径的笔记
   * 同时清理因此变空的日期条目
   */
  removeFileFromCache(path) {
    for (const dateStr in this.noteCache) {
      const notes = this.noteCache[dateStr];
      const filtered = notes.filter(n => n.path !== path);
      if (filtered.length === 0) {
        delete this.noteCache[dateStr];
      } else if (filtered.length !== notes.length) {
        this.noteCache[dateStr] = filtered;
      }
    }
  }

  /**
   * 根据文件信息（创建/修改时间）将笔记加入对应日期的 noteCache
   * 若创建日期与修改日期同一天，只记一次（type 为 created）
   * @param {{path, title, ctime, mtime}} info
   */
  addFileToCache(info) {
    const createdDateStr = this.formatDate(new Date(info.ctime));
    const modifiedDateStr = this.formatDate(new Date(info.mtime));

    if (!this.noteCache[createdDateStr]) {
      this.noteCache[createdDateStr] = [];
    }
    this.noteCache[createdDateStr].push({
      path: info.path,
      title: info.title,
      type: 'created'
    });

    // 创建与修改不同天才记 updated
    if (modifiedDateStr !== createdDateStr) {
      if (!this.noteCache[modifiedDateStr]) {
        this.noteCache[modifiedDateStr] = [];
      }
      this.noteCache[modifiedDateStr].push({
        path: info.path,
        title: info.title,
        type: 'updated'
      });
    }
  }

  /**
   * 获取当前视图的年月
   */
  getViewDate() {
    return { year: this.viewYear, month: this.viewMonth };
  }

  /**
   * 设置视图日期
   */
  setViewDate(year, month) {
    this.viewYear = year;
    this.viewMonth = month;
  }

  /**
   * 上一个月
   */
  previousMonth() {
    if (this.viewMonth === 1) {
      this.viewMonth = 12;
      this.viewYear--;
    } else {
      this.viewMonth--;
    }
  }

  /**
   * 下一个月
   */
  nextMonth() {
    if (this.viewMonth === 12) {
      this.viewMonth = 1;
      this.viewYear++;
    } else {
      this.viewMonth++;
    }
  }

  /**
   * 上一年
   */
  previousYear() {
    this.viewYear--;
  }

  /**
   * 下一年
   */
  nextYear() {
    this.viewYear++;
  }

  /**
   * 获取月份的第一天是星期几 (0=周日, 1=周一, ..., 6=周六)
   * @param {number} year 年份
   * @param {number} month 月份
   * @returns {number} 调整后的星期数
   */
  getFirstDayOfMonth(year, month) {
    const date = new Date(year, month - 1, 1);
    let day = date.getDay();

    // 如果起始日是周一（1），需要调整
    if (this.startOfWeek === 1) {
      // 周日(0) -> 6, 周一(1) -> 0, 周二(2) -> 1, ...
      day = (day + 6) % 7;
    }

    return day;
  }

  /**
   * 获取星期标题
   * @returns {string[]} 星期标题数组
   */
  getWeekdayLabels() {
    if (this.startOfWeek === 0) {
      // 周日起始
      return ['日', '一', '二', '三', '四', '五', '六'];
    } else {
      // 周一起始
      return ['一', '二', '三', '四', '五', '六', '日'];
    }
  }

  /**
   * 获取月份的总天数
   */
  getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  /**
   * 获取日历网格数据
   */
  getCalendarData() {
    const firstDay = this.getFirstDayOfMonth(this.viewYear, this.viewMonth);
    const daysInMonth = this.getDaysInMonth(this.viewYear, this.viewMonth);

    const calendarDays = [];

    // 填充上个月的日期
    const prevMonthDays = this.getDaysInMonth(
      this.viewMonth === 1 ? this.viewYear - 1 : this.viewYear,
      this.viewMonth === 1 ? 12 : this.viewMonth - 1
    );
    const prevMonthYear = this.viewMonth === 1 ? this.viewYear - 1 : this.viewYear;
    const prevMonth = this.viewMonth === 1 ? 12 : this.viewMonth - 1;
    for (let i = firstDay - 1; i >= 0; i--) {
      const day = prevMonthDays - i;
      const date = new Date(prevMonthYear, prevMonth - 1, day);
      calendarDays.push({
        day: day,
        isCurrentMonth: false,
        date: date,
        weekNumber: null
      });
    }

    // 填充当月日期
    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(this.viewYear, this.viewMonth - 1, i);
      calendarDays.push({
        day: i,
        isCurrentMonth: true,
        date: date,
        isToday: this.isToday(this.viewYear, this.viewMonth, i),
        weekNumber: this.getWeekNumber(date)
      });
    }

    // 填充下个月的日期（补齐6行，42个格子）
    const totalCells = 42;
    const remainingCells = totalCells - calendarDays.length;
    const nextMonthYear = this.viewMonth === 12 ? this.viewYear + 1 : this.viewYear;
    const nextMonth = this.viewMonth === 12 ? 1 : this.viewMonth + 1;
    for (let i = 1; i <= remainingCells; i++) {
      const date = new Date(nextMonthYear, nextMonth - 1, i);
      calendarDays.push({
        day: i,
        isCurrentMonth: false,
        date: date,
        weekNumber: null
      });
    }

    return calendarDays;
  }

  /**
   * 判断是否为今天
   */
  isToday(year, month, day) {
    const today = new Date();
    return today.getFullYear() === year &&
           today.getMonth() + 1 === month &&
           today.getDate() === day;
  }

  /**
   * 计算周数
   * @param {Date} date - 日期对象
   * @returns {number} 周数（1-52）
   */
getWeekNumber(date) {
  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7; 
  target.setDate(target.getDate() - dayNr + 3); 
  const firstThursday = target.valueOf();
  target.setMonth(0, 1); 
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7); 
  }
  return 1 + Math.ceil((firstThursday - target) / 604800000); 
}

  /**
   * 跳转到今天
   */
  goToToday() {
    const today = new Date();
    this.viewYear = today.getFullYear();
    this.viewMonth = today.getMonth() + 1;
    // 创建一个时间一致的新日期对象
    this.selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    this.selectedDate.setHours(0, 0, 0, 0);
  }

  /**
   * 选择日期
   */
  selectDate(year, month, day) {
    this.selectedDate = new Date(year, month - 1, day);
  }

  /**
   * 将选中日期移动 deltaDays 天（支持负数），并同步切换视图月份
   * 用于键盘方向键导航
   */
  moveSelection(deltaDays) {
    if (!this.selectedDate) return;
    const next = new Date(this.selectedDate.getFullYear(), this.selectedDate.getMonth(), this.selectedDate.getDate());
    next.setDate(next.getDate() + deltaDays);
    this.selectedDate = next;
    this.viewYear = next.getFullYear();
    this.viewMonth = next.getMonth() + 1;
  }

  /**
   * 判断是否是选中的日期
   */
  isSelectedDate(year, month, day) {
    if (!this.selectedDate) return false;
    return this.selectedDate.getFullYear() === year &&
           this.selectedDate.getMonth() + 1 === month &&
           this.selectedDate.getDate() === day;
  }
}

// 插件主体
module.exports = class NoteCalendarPlugin extends Plugin {
  async onload() {
    // 加载lunar.js
    const lunarPath = this.app.vault.adapter.basePath + "/.obsidian/plugins/" + this.manifest.id + "/lunar.js";
    const lunarModule = require(lunarPath);
    Lunar = lunarModule.Lunar;
    Solar = lunarModule.Solar;
    HolidayUtil = lunarModule.HolidayUtil;

    // 追加 2027 年节假日数据（lunar.js 内置数据仅覆盖到 2026-10）
    HolidayUtil.fix(HOLIDAY_FIX_DATA);

    // 加载设置
    await this.loadSettings();

    // 注册日历视图类型
    this.registerView(
      VIEW_TYPE_CALENDAR,
      (leaf) => new CalendarView(leaf, this)
    );

    // 添加设置菜单
    this.addSettingTab(new CalendarSettingTab(this.app, this));

    // 添加命令：切换日历视图
    this.addCommand({
      id: 'toggle-note-calendar',
      name: '切换日历视图',
      checkCallback: (checking) => {
        // 总是允许调用，由我们自己管理切换逻辑
        return true;
      },
      callback: () => {
        this.toggleCalendarView();
      }
    });

    // 在布局准备好时自动初始化视图
    this.app.workspace.onLayoutReady(() => {
      this.initLeaf();
      // 初始扫描笔记
      setTimeout(() => {
        this.scanNotes();
      }, 1000);
    });

    // 监听文件创建事件
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file.extension === 'md') {
          this.refreshFile(file.path);
        }
      })
    );
    // 监听文件修改事件
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file.extension === 'md') {
          this.refreshFile(file.path);
        }
      })
    );

    // 监听文件重命名事件
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file.extension === 'md') {
          this.handleRename(oldPath, file.path);
        }
      })
    );

    // 监听文件删除事件
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file.extension === 'md') {
          this.handleDelete(file.path);
        }
      })
    );

  }

  /**
   * 加载设置
   */
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /**
   * 保存设置
   */
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * 更新设置
   */
  async updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    await this.saveSettings();

    // 更新所有打开的日历视图
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
    leaves.forEach(leaf => {
      const view = leaf.view;
      if (view.model) {
        view.model.startOfWeek = this.settings.startOfWeek;
        view.model.weekendColor = this.settings.weekendColor;
        view.model.themeColor = this.settings.themeColor;
        view.model.bgColor = this.settings.bgColor;
        view.model.showLunarDate = this.settings.showLunarDate;
        view.model.showSolarFestivals = this.settings.showSolarFestivals;
        view.model.showLunarFestivals = this.settings.showLunarFestivals;
        view.model.showJieQi = this.settings.showJieQi;
        view.model.showHolidayMarker = this.settings.showHolidayMarker;
        view.model.showHongKongHolidays = this.settings.showHongKongHolidays;
        view.model.noteFolderPath = this.settings.noteFolderPath;
        view.model.dateFormat = this.settings.dateFormat;
        view.model.templatePath = this.settings.templatePath;
        view.model.defaultCreateFolder = this.settings.defaultCreateFolder;
        view.model.fontFamily = this.settings.fontFamily;
        view.model.fontSize = this.settings.fontSize;
        view.render();
      }
    });
  }

  /**
   * 全量扫描笔记并重建缓存与反向索引
   * 并行 stat 所有文件，避免大库下的顺序 IO 等待
   */
  async scanNotes() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
    if (leaves.length === 0) return;

    const view = leaves[0].view;
    if (!view || !view.model) return;

    const model = view.model;
    const folder = this.settings.noteFolderPath;

    // 仅保留目标文件夹内的文件
    const files = this.app.vault.getMarkdownFiles().filter(
      f => isPathInFolder(f.path, folder)
    );

    // 并行获取 stat
    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const stat = await this.app.vault.adapter.stat(file.path);
          if (!stat) return null;
          return { path: file.path, title: file.basename, ctime: stat.ctime, mtime: stat.mtime };
        } catch (e) {
          return null;
        }
      })
    );

    // 重建索引与缓存
    model.noteCache = {};
    model.fileIndex = new Map();
    for (const info of results) {
      if (!info) continue;
      model.fileIndex.set(info.path, info);
      model.addFileToCache(info);
    }

    view.render();
  }

  /**
   * 增量刷新单个文件：更新 fileIndex 与 noteCache，然后重渲染
   * 用于 create/modify 事件。若文件不在目标文件夹内则从索引移除。
   */
  async refreshFile(filePath) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
    if (leaves.length === 0) return;
    const view = leaves[0].view;
    if (!view || !view.model) return;
    const model = view.model;

    const inFolder = isPathInFolder(filePath, this.settings.noteFolderPath);

    // 无论是否在文件夹内，先移除旧的缓存条目（重命名/移动出文件夹的情况）
    model.removeFileFromCache(filePath);
    model.fileIndex.delete(filePath);

    if (!inFolder) {
      view.render();
      return;
    }

    const stat = await this.app.vault.adapter.stat(filePath);
    if (!stat) {
      view.render();
      return;
    }

    const info = { path: filePath, title: filePath.split('/').pop().replace(/\.md$/i, ''), ctime: stat.ctime, mtime: stat.mtime };
    model.fileIndex.set(filePath, info);
    model.addFileToCache(info);
    view.render();
  }

  /**
   * 处理文件重命名：复用旧条目的 ctime/mtime（重命名不改文件时间），
   * 用新路径计算标题，避免依赖 adapter.stat 在 rename 事件瞬间的时序问题
   */
  async handleRename(oldPath, newPath) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
    if (leaves.length === 0) return;
    const view = leaves[0].view;
    if (!view || !view.model) return;
    const model = view.model;

    // 取旧条目以保留不变的创建/修改时间
    const oldInfo = model.fileIndex.get(oldPath);
    // 清掉旧路径的缓存与索引
    model.removeFileFromCache(oldPath);
    model.fileIndex.delete(oldPath);

    if (oldInfo) {
      // 直接用旧时间 + 新路径/新标题重建，不依赖 stat
      const newInfo = {
        path: newPath,
        title: newPath.split('/').pop().replace(/\.md$/i, ''),
        ctime: oldInfo.ctime,
        mtime: oldInfo.mtime
      };
      // 仅当新路径仍在目标文件夹内才加入缓存（处理移动出文件夹的情况）
      if (isPathInFolder(newPath, this.settings.noteFolderPath)) {
        model.fileIndex.set(newPath, newInfo);
        model.addFileToCache(newInfo);
      }
      view.render();
    } else {
      // 旧条目不在索引中（scanNotes 未运行或原本不在文件夹内），回退到 stat 刷新
      await this.refreshFile(newPath);
    }
  }

  /**
   * 处理文件删除：从索引和缓存移除，然后重渲染
   */
  handleDelete(filePath) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
    if (leaves.length === 0) return;
    const view = leaves[0].view;
    if (!view || !view.model) return;
    const model = view.model;

    model.removeFileFromCache(filePath);
    model.fileIndex.delete(filePath);
    view.render();
  }

  async onunload() {
    // 卸载时关闭视图
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
    leaves.forEach(leaf => leaf.detach());
  }

  /**
   * 初始化日历视图（在布局准备好时调用）
   */
  initLeaf() {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length > 0) {
      return;
    }
    this.app.workspace.getRightLeaf(false)?.setViewState({
      type: VIEW_TYPE_CALENDAR
    });
  }

  /**
   * 切换日历视图显示/隐藏
   */
  async toggleCalendarView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);

    if (leaves.length > 0) {
      // 如果已打开，关闭视图
      leaves[0].detach();
    } else {
      // 如果未打开，在右侧栏创建新视图
      const leaf = this.app.workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_CALENDAR,
          active: true
        });
      }
    }
  }
}

/**
 * 日历视图类
 */
class CalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.model = new CalendarModel(plugin.settings || {});
    this.container = null;
    this.header = null;
    this.grid = null;
    this.todayBtn = null; // 今天按钮引用
    // 农历/节假日计算缓存：lunar.js 相关方法均为纯函数，按日期 key 缓存安全
    this.dayInfoCache = new Map(); // YYYY-MM-DD -> dayInfo
    this.monthLunarCache = new Map(); // year-month -> 农历标题字符串
  }

  /**
   * 获取单日的农历/节日/调休信息（带缓存）
   * lunar.js 的相关方法均为纯函数，结果按日期缓存，软上限 2000 条
   */
  getDayInfo(date) {
    // 缓存 key 纳入香港假期开关状态，切换开关后自动重新计算
    const key = this.model.formatDate(date) + (this.model.showHongKongHolidays ? '|hk' : '');
    if (this.dayInfoCache.has(key)) {
      return this.dayInfoCache.get(key);
    }
    // 软上限：超出时清空，避免极端情况下无限增长
    if (this.dayInfoCache.size > 2000) {
      this.dayInfoCache.clear();
    }
    const solarDay = Solar.fromDate(date);
    const lunarDay = solarDay.getLunar();
    const dayInChinese = lunarDay.getDayInChinese();
    const lunarText = dayInChinese === '初一'
      ? lunarDay.getMonthInChinese() + '月'
      : dayInChinese;

    const info = {
      lunarText,
      lunarFestivals: lunarDay.getFestivals(),
      solarFestivals: solarDay.getFestivals(),
      jieQi: lunarDay.getJieQi(),
      holiday: HolidayUtil.getHoliday(date.getFullYear(), date.getMonth() + 1, date.getDate()),
      hkFestival: null,
      isWeekend: date.getDay() === 0 || date.getDay() === 6
    };

    // 香港公众假期：覆盖 holiday 使其显示"休"标记，并记录假期名
    if (this.model.showHongKongHolidays) {
      const hkName = HK_HOLIDAYS[this.model.formatDate(date)];
      if (hkName) {
        info.hkFestival = hkName;
        info.holiday = { isWork: () => false, getName: () => hkName };
      }
    }

    this.dayInfoCache.set(key, info);
    return info;
  }

  /**
   * 获取月份的农历标题字符串（带缓存），用于头部显示
   */
  getMonthLunarInfo(year, month) {
    const key = `${year}-${month}`;
    if (this.monthLunarCache.has(key)) {
      return this.monthLunarCache.get(key);
    }
    const lunarDay = Solar.fromYmd(year, month, 1).getLunar();
    const str = lunarDay.getYearInGanZhi() + lunarDay.getYearShengXiao() + '年 ' + lunarDay.getMonthInChinese() + '月';
    this.monthLunarCache.set(key, str);
    return str;
  }

  /**
   * 获取视图类型
   */
  getViewType() {
    return VIEW_TYPE_CALENDAR;
  }

  /**
   * 获取显示文本
   */
  getDisplayText() {
    return '日历';
  }

  /**
   * 获取图标
   */
  getIcon() {
    return 'calendar-with-checkmark';
  }

  async onOpen() {
    // 添加视图类名
    this.contentEl.addClass('note-calendar-view');

    // 创建日历容器
    this.createCalendarView();

    // 视图打开后聚焦网格，便于键盘导航
    requestAnimationFrame(() => {
      if (this.grid) this.grid.focus();
    });
  }

  /**
   * 创建日历视图
   */
  createCalendarView() {
    // 清空容器
    this.contentEl.empty();

    // 应用CSS变量
    this.contentEl.style.setProperty('--calendar-weekend-color', this.model.weekendColor);
    this.contentEl.style.setProperty('--calendar-bg', this.model.bgColor);
    this.contentEl.style.setProperty('--calendar-font-family', this.getFontFamilyValue());
    this.contentEl.style.setProperty('--calendar-font-size', this.model.fontSize + 'px');

    // 创建头部
    this.header = this.createHeader();
    this.contentEl.appendChild(this.header);

    // 创建网格
    this.grid = this.createGrid();
    this.contentEl.appendChild(this.grid);

    // 创建笔记列表容器
    this.notesList = this.createNotesList();
    this.contentEl.appendChild(this.notesList);

    // 确保DOM更新后再渲染
    requestAnimationFrame(() => {
      this.render();
    });

    this.container = this.contentEl;
  }

  /**
   * 创建头部
   */
  createHeader() {
    const header = document.createElement('div');
    header.className = 'calendar-header';

    // 左侧切换按钮组
    const leftNavGroup = document.createElement('div');
    leftNavGroup.className = 'calendar-nav-group calendar-nav-left';

    // 上一年按钮
    const prevYearBtn = document.createElement('button');
    prevYearBtn.className = 'calendar-btn calendar-nav-btn';
    prevYearBtn.textContent = '<<';
    prevYearBtn.onclick = () => {
      this.model.previousYear();
      this.render();
    };
    leftNavGroup.appendChild(prevYearBtn);

    // 上个月按钮
    const prevMonthBtn = document.createElement('button');
    prevMonthBtn.className = 'calendar-btn calendar-nav-btn';
    prevMonthBtn.textContent = '<';
    prevMonthBtn.onclick = () => {
      this.model.previousMonth();
      this.render();
    };
    leftNavGroup.appendChild(prevMonthBtn);

    header.appendChild(leftNavGroup);

    // 中间标题组（包含标题）
    const titleGroup = document.createElement('div');
    titleGroup.className = 'calendar-title-group';

    // 标题
    const title = document.createElement('div');
    title.className = 'calendar-title';
    titleGroup.appendChild(title);

    const lunarTitle = document.createElement('div');
    lunarTitle.className = 'calendar-lunar-title';
    titleGroup.appendChild(lunarTitle);
    
    header.appendChild(titleGroup);

    // 今天按钮（右上角绝对定位）
    const todayBtn = document.createElement('button');
    todayBtn.className = 'calendar-btn calendar-today-btn';
    todayBtn.textContent = '今';
    todayBtn.onclick = () => {
      this.model.goToToday();
      this.todayBtn.classList.add('calendar-today-btn-selected');
      this.render();
    };
    header.appendChild(todayBtn);
    this.todayBtn = todayBtn;

    // 右侧切换按钮组
    const rightNavGroup = document.createElement('div');
    rightNavGroup.className = 'calendar-nav-group calendar-nav-right';

    // 下个月按钮
    const nextMonthBtn = document.createElement('button');
    nextMonthBtn.className = 'calendar-btn calendar-nav-btn';
    nextMonthBtn.textContent = '>';
    nextMonthBtn.onclick = () => {
      this.model.nextMonth();
      this.render();
    };
    rightNavGroup.appendChild(nextMonthBtn);

    // 下一年按钮
    const nextYearBtn = document.createElement('button');
    nextYearBtn.className = 'calendar-btn calendar-nav-btn';
    nextYearBtn.textContent = '>>';
    nextYearBtn.onclick = () => {
      this.model.nextYear();
      this.render();
    };
    rightNavGroup.appendChild(nextYearBtn);

    header.appendChild(rightNavGroup);

    this.titleEl = title;
    this.lunarTitleEl = lunarTitle;
    return header;
  }

  /**
   * 创建网格
   */
  createGrid() {
    const grid = document.createElement('div');
    grid.className = 'calendar-grid';
    // 使网格可聚焦，以支持键盘方向键导航日期
    grid.tabIndex = 0;
    grid.setAttribute('role', 'grid');
    this.attachKeyboardNav(grid);
    return grid;
  }

  /**
   * 绑定键盘方向键导航：方向键移动选中日期，Enter 打开当天首个笔记
   * 跨月移动时同步切换视图月份
   */
  attachKeyboardNav(grid) {
    grid.addEventListener('keydown', (e) => {
      let delta = 0;
      switch (e.key) {
        case 'ArrowRight': delta = 1; break;
        case 'ArrowLeft': delta = -1; break;
        case 'ArrowDown': delta = 7; break;
        case 'ArrowUp': delta = -7; break;
        case 'Enter': {
          e.preventDefault();
          this.openSelectedDateFirstNote();
          return;
        }
        default: return;
      }
      e.preventDefault();
      this.model.moveSelection(delta);
      this.render();
    });
  }

  /**
   * 打开当前选中日期的第一个笔记（无笔记则无操作）
   */
  openSelectedDateFirstNote() {
    const selectedDate = this.model.selectedDate;
    if (!selectedDate) return;
    const dateStr = this.model.formatDate(selectedDate);
    const notes = this.model.getNotesForDate(dateStr);
    if (notes.length === 0) return;
    const note = notes[0];
    const file = this.app.vault.getAbstractFileByPath(note.path);
    if (file) {
      this.app.workspace.getLeaf(false).openFile(file);
    }
  }


  /**
   * 更新网格
   */
  updateGrid() {
    // 清空现有内容
    this.grid.innerHTML = '';

    // 获取日历数据
    const calendarData = this.model.getCalendarData();

    // 添加周数标题
    const weekNumberHeader = document.createElement('div');
    weekNumberHeader.className = 'calendar-week-number-header';
    weekNumberHeader.textContent = '周';
    this.grid.appendChild(weekNumberHeader);

    // 添加星期标题
    const weekdays = this.model.getWeekdayLabels();
    weekdays.forEach((day, index) => {
      const weekdayEl = document.createElement('div');
      weekdayEl.className = 'calendar-weekday';
      const isWeekend = (this.model.startOfWeek === 0 && index === 0) ||
                        (this.model.startOfWeek === 0 && index === 6) ||
                        (this.model.startOfWeek === 1 && index === 5) ||
                        (this.model.startOfWeek === 1 && index === 6);
      if (isWeekend) {
        weekdayEl.classList.add('calendar-weekend');
      }
      weekdayEl.textContent = day;
      this.grid.appendChild(weekdayEl);
    });

    // 用于跟踪当前的周数
    let dayInRow = 0;

    // 渲染周数和日期
    calendarData.forEach((dayData) => {
      const info = this.getDayInfo(dayData.date);
      const holiday = info.holiday;
      if (dayData.date) {
        // 检查是否是每行的第一个日期
        if (dayInRow === 0) {
          // 为每行都计算周数，即使日期是上个月或下个月的
          const weekNumber = dayData.weekNumber !== null ? dayData.weekNumber : this.model.getWeekNumber(dayData.date);

          // 添加周数单元格
          const weekNumberCell = document.createElement('div');
          weekNumberCell.className = 'calendar-week-number';
          weekNumberCell.textContent = weekNumber;
          this.grid.appendChild(weekNumberCell);
        }

        // 添加日期单元格
        const dayCell = document.createElement('div');
        dayCell.className = 'calendar-day';

        if (!dayData.isCurrentMonth) {
          dayCell.classList.add('calendar-day-other');
        }

        if (dayData.isToday) {
          dayCell.classList.add('calendar-day-today');
        }

        // 处理周末颜色逻辑 - 跟随调休状态
        const isWeekend = info.isWeekend;
        const hasHoliday = holiday !== null;

        if (isWeekend) {
          dayCell.classList.add('calendar-day-weekend');
          // 如果周末有"班"字（调休上班），显示为白色
          if (hasHoliday && holiday.isWork()) {
            dayCell.classList.add('calendar-day-weekend-work');
          }
        } else {
          // 如果周内有"休"字（放假），显示为红色（周末颜色）
          if (hasHoliday && !holiday.isWork()) {
            dayCell.classList.add('calendar-day-holiday-rest-color');
          }
        }

        // 检查是否是选中的日期
        if (this.model.isSelectedDate(dayData.date.getFullYear(), dayData.date.getMonth() + 1, dayData.date.getDate())) {
          dayCell.classList.add('calendar-day-selected');
        }

        // 创建公历日期元素
        const dayText = document.createElement('div');
        dayText.className = 'calendar-day-text';
        dayText.textContent = dayData.day;
        dayCell.appendChild(dayText);

        // 添加农历日期
        if (this.model.showLunarDate) {
          const lunarDayText = document.createElement('div');
          lunarDayText.className = 'calendar-day-lunar';
          lunarDayText.textContent = info.lunarText;
          dayCell.appendChild(lunarDayText);
        }


        // 节日文本：香港假期名优先（开关开启且当天为香港假期时，
        // 只显示香港名称，跳过农历/阳历节日与节气文本，避免同一天多行重复）
        if (info.hkFestival) {
          const hkText = document.createElement('div');
          hkText.className = 'calendar-day-festival';
          hkText.textContent = info.hkFestival;
          dayCell.appendChild(hkText);
        } else {
          // 获取农历节日
          if (this.model.showLunarFestivals) {
            const lunarFestivals = info.lunarFestivals;
            if (lunarFestivals && lunarFestivals.length > 0) {
              const lunarFestivalText = document.createElement('div');
              lunarFestivalText.className = 'calendar-day-festival';
              lunarFestivalText.textContent = lunarFestivals[0];
              dayCell.appendChild(lunarFestivalText);
            }
          }


          // 获取阳历节日
          if (this.model.showSolarFestivals) {
            const solarFestivals = info.solarFestivals;
            if (solarFestivals && solarFestivals.length > 0) {
              const solarFestivalText = document.createElement('div');
              solarFestivalText.className = 'calendar-day-festival';
              solarFestivalText.textContent = solarFestivals[0];
              dayCell.appendChild(solarFestivalText);
            }
          }

          // 获取节气
          if (this.model.showJieQi) {
            const lunarJieQi = info.jieQi;
            if (lunarJieQi) {
              const lunarJieQiText = document.createElement('div');
              lunarJieQiText.className = 'calendar-day-festival';
              lunarJieQiText.textContent = lunarJieQi;
              dayCell.appendChild(lunarJieQiText);
            }
          }
        }

        // 添加调休标示
        if (holiday && this.model.showHolidayMarker) {
          const holidayMarker = document.createElement('div');
          holidayMarker.className = 'calendar-holiday-marker';
          if (holiday.isWork()) {
            // isWork()为true表示调休上班，显示"班"
            holidayMarker.classList.add('calendar-holiday-work');
            holidayMarker.textContent = '班';
          } else {
            // isWork()为false表示放假，显示"休"
            holidayMarker.classList.add('calendar-holiday-rest');
            holidayMarker.textContent = '休';
          }
          dayCell.appendChild(holidayMarker);
        }

        // 添加笔记圆点标记
        const dateStr = this.model.formatDate(dayData.date);
        const notes = this.model.getNotesForDate(dateStr);
        if (notes.length > 0) {
          const noteDotsContainer = document.createElement('div');
          noteDotsContainer.className = 'calendar-note-dots';
          
          // 最多显示两个圆点，一个是创建，一个是更新
          const hasCreated = notes.some(n => n.type === 'created');
          const hasUpdated = notes.some(n => n.type === 'updated');
          if (hasCreated) {
            const dotCreated = document.createElement('div');
            dotCreated.className = 'calendar-note-dot';
            dotCreated.classList.add('calendar-note-dot-created');
            noteDotsContainer.appendChild(dotCreated);
          }

          if (hasUpdated) {
            const dotUpdate = document.createElement('div');
            dotUpdate.className = 'calendar-note-dot';
            dotUpdate.classList.add('calendar-note-dot-updated');
            noteDotsContainer.appendChild(dotUpdate);
          }
          dayCell.appendChild(noteDotsContainer);
        }

        // 添加点击事件
        dayCell.onclick = () => {
          const year = dayData.date.getFullYear();
          const month = dayData.date.getMonth() + 1;
          const day = dayData.date.getDate();
          this.model.selectDate(year, month, day);
          this.render();
          // 点击后回焦网格，保证键盘导航仍可用
          this.grid.focus();
        };        

        this.grid.appendChild(dayCell);

        // 更新行内日期计数
        dayInRow++;
        if (dayInRow === 7) {
          dayInRow = 0;
        }
      }
    });
  }

  /**
   * 创建笔记列表容器
   * 内容由 updateNotesList 填充，这里只建空容器
   */
  createNotesList() {
    const container = document.createElement('div');
    container.className = 'calendar-notes-list';
    return container;
  }

  /**
   * 构建笔记创建按钮组（日记/周/季/年），供 updateNotesList 复用
   */
  createNoteButtons() {
    const createBtnGroup = document.createElement('div');
    createBtnGroup.className = 'calendar-create-btn-group';

    const buttons = [
      { text: '+', title: '创建日记', type: 'daily' },
      { text: '周', title: '创建周周记', type: 'weekly' },
      { text: '季', title: '创建季度笔记', type: 'quarterly' },
      { text: '年', title: '创建年度笔记', type: 'yearly' }
    ];
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'calendar-create-note-btn';
      btn.textContent = b.text;
      btn.title = b.title;
      btn.onclick = () => this.showCreateNoteDialog(b.type);
      createBtnGroup.appendChild(btn);
    }
    return createBtnGroup;
  }

  /**
   * 更新笔记列表
   */
  updateNotesList() {
    if (!this.notesList) return;

    // 清空笔记列表
    this.notesList.empty();

    // 获取选中日期
    const selectedDate = this.model.selectedDate;
    if (!selectedDate) return;

    // 格式化日期显示
    const year = selectedDate.getFullYear();
    const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
    const day = String(selectedDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // 创建标题容器（包含创建按钮和日期标题）
    const titleContainer = document.createElement('div');
    titleContainer.className = 'calendar-notes-title-container';
    
    titleContainer.appendChild(this.createNoteButtons());
    
    // 创建日期标题
    const titleEl = document.createElement('div');
    titleEl.className = 'calendar-notes-title';
    titleEl.textContent = `${year}年${month}月${day}日`;
    titleContainer.appendChild(titleEl);
    
    this.notesList.appendChild(titleContainer);

    // 获取该日期的笔记列表
    const notes = this.model.getNotesForDate(dateStr);

    // 创建笔记列表容器
    const notesContainer = document.createElement('div');
    notesContainer.className = 'calendar-notes-items';

    if (notes.length > 0) {
      notes.forEach(note => {
        const noteItem = document.createElement('div');
        noteItem.className = 'calendar-note-item';

        // 创建圆点
        const dot = document.createElement('div');
        dot.className = 'calendar-note-item-dot';
        if (note.type === 'created') {
          dot.classList.add('calendar-note-dot-created');
        } else {
          dot.classList.add('calendar-note-dot-updated');
        }
        noteItem.appendChild(dot);

        // 创建标题
        const titleSpan = document.createElement('span');
        titleSpan.className = 'calendar-note-item-title';
        titleSpan.textContent = note.title;
        noteItem.appendChild(titleSpan);

        // 添加点击事件
        noteItem.onclick = async () => {
          // 打开笔记文件
          const file = this.app.vault.getAbstractFileByPath(note.path);
          if (file) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
          }
        };

        notesContainer.appendChild(noteItem);
      });
    } else {
      // 显示无笔记提示
      const emptyEl = document.createElement('div');
      emptyEl.className = 'calendar-notes-empty';
      emptyEl.textContent = '该日期暂无笔记';
      notesContainer.appendChild(emptyEl);
    }

    this.notesList.appendChild(notesContainer);
  }

  /**
   * 显示创建笔记对话框
   */
  showCreateNoteDialog(type = 'daily') {
    const selectedDate = this.model.selectedDate;
    if (!selectedDate) return;
    
    const year = selectedDate.getFullYear();
    const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
    const day = String(selectedDate.getDate()).padStart(2, '0');
    
    // 根据笔记类型生成默认标题
    let defaultTitle;
    switch (type) {
      case 'weekly':
        // 计算当前周数
        const weekNumber = this.model.getWeekNumber(selectedDate);
        defaultTitle = `${year}-${weekNumber}周`;
        break;
      case 'quarterly':
        // 计算当前季度
        const quarter = Math.floor(selectedDate.getMonth() / 3) + 1;
        defaultTitle = `${year}年-${quarter}季度`;
        break;
      case 'yearly':
        defaultTitle = `${year}`;
        break;
      case 'daily':
      default:
        // 根据设置的日期格式生成默认标题
        const dateFormat = this.model.dateFormat || 'YYYY-MM-DD';
        defaultTitle = dateFormat
          .replace('YYYY', year)
          .replace('MM', month)
          .replace('DD', day);
        break;
    }
    
    // 创建对话框
    const modal = new Modal(this.app);
    modal.titleEl.textContent = type === 'daily' ? '创建新笔记' : `创建${type === 'weekly' ? '周周记' : type === 'quarterly' ? '季度笔记' : '年度笔记'}`;
    
    // 创建表单
    const form = document.createElement('form');
    form.className = 'nc-modal-form';
    
    // 标题输入框
    const titleDiv = document.createElement('div');
    titleDiv.className = 'nc-modal-field';
    
    const titleLabel = document.createElement('label');
    titleLabel.className = 'nc-modal-label';
    titleLabel.textContent = '笔记标题:';
    titleDiv.appendChild(titleLabel);
    
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'nc-modal-input';
    titleInput.value = defaultTitle;
    titleDiv.appendChild(titleInput);
    form.appendChild(titleDiv);
    
    // 文件夹路径输入框
    const folderDiv = document.createElement('div');
    folderDiv.className = 'nc-modal-field';
    
    const folderLabel = document.createElement('label');
    folderLabel.className = 'nc-modal-label';
    folderLabel.textContent = '文件夹路径:';
    folderDiv.appendChild(folderLabel);
    
    const folderInput = document.createElement('input');
    folderInput.type = 'text';
    folderInput.className = 'nc-modal-input';
    folderInput.placeholder = '例如: notes/日记';
    folderInput.value = this.model.defaultCreateFolder || '';
    folderDiv.appendChild(folderInput);
    form.appendChild(folderDiv);
    
    // 按钮容器
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'nc-modal-button-row';
    
    // 取消按钮
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'nc-modal-btn nc-modal-btn-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => modal.close();
    buttonContainer.appendChild(cancelBtn);
    
    // 确认按钮
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'nc-modal-btn nc-modal-btn-confirm';
    confirmBtn.textContent = '确认';
    confirmBtn.onclick = async () => {
      const title = titleInput.value.trim();
      const folderPath = folderInput.value.trim();
      
      if (!title) {
        new Notice('笔记标题不能为空');
        return;
      }
      
      await this.createNote(title, folderPath, type);
      modal.close();
    };
    buttonContainer.appendChild(confirmBtn);
    form.appendChild(buttonContainer);
    
    modal.contentEl.appendChild(form);
    modal.open();
  }

  /**
   * 创建笔记
   */
  async createNote(title, folderPath, type) {
    try {
      // 使用 normalizePath 标准化路径（处理反斜杠、首尾斜杠等）
      const normalizedFolder = folderPath ? normalizePath(folderPath) : '';

      // 构建文件路径
      let filePath;
      if (normalizedFolder) {
        filePath = normalizePath(`${normalizedFolder}/${title}.md`);
      } else {
        filePath = normalizePath(`${title}.md`);
      }

      // 检查文件是否已存在
      const existingFile = this.app.vault.getAbstractFileByPath(filePath);
      if (existingFile) {
        new Notice('该笔记已存在');
        return;
      }

      // 创建文件夹（如果不存在）- 逐级创建，使用不带尾部斜杠的标准化路径
      if (normalizedFolder) {
        const folderParts = normalizedFolder.split('/');
        let currentPath = '';

        for (const part of folderParts) {
          if (!part) continue;
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          // normalizePath 确保路径格式正确
          currentPath = normalizePath(currentPath);

          const folder = this.app.vault.getAbstractFileByPath(currentPath);
          if (!folder) {
            await this.app.vault.createFolder(currentPath);
          }
        }
      }

      // 获取模板内容
      const templateContent = await this.getTemplateContent(type, title);

      // 创建笔记文件（带模板内容）
      const file = await this.app.vault.create(filePath, templateContent);

      // 显示成功通知
      new Notice('笔记创建成功');

      // 自动打开新创建的笔记
      await this.app.workspace.openLinkText(file.path, '', false);

      // 增量刷新该文件的缓存（create 事件也会触发，幂等）
      this.plugin.refreshFile(file.path);
    } catch (error) {
      console.error('[NoteCalendar] 创建笔记失败:', error);
      new Notice('创建笔记失败: ' + error.message);
    }
  }

  /**
   * 获取模板内容
   * 优先级：插件设置 > 核心"日记"插件的模板设置
   * 支持 {{date}}、{{date:FORMAT}}、{{time}}、{{time:FORMAT}}、{{title}} 模板变量
   * @param {string} type - 笔记类型：daily/weekly/quarterly/yearly
   * @param {string} title - 笔记标题
   * @returns {string} 处理后的模板内容，无模板则返回空字符串
   */
  async getTemplateContent(type, title) {
    try {
      let templatePath = '';

      // 优先使用插件自己配置的模板路径
      if (this.model.templatePath) {
        templatePath = this.model.templatePath;
      }

      // 如果插件没配置，尝试读取核心"日记"插件的模板设置（仅对 daily 类型）
      if (!templatePath && type === 'daily') {
        const dailyNotesPlugin = this.app.internalPlugins && this.app.internalPlugins.plugins['daily-notes'];
        if (dailyNotesPlugin && dailyNotesPlugin.instance) {
          const options = dailyNotesPlugin.instance.options || {};
          if (options.template) {
            templatePath = options.template;
          }
        }
      }

      // 没有配置模板，返回空字符串
      if (!templatePath) {
        return '';
      }

      // 标准化模板路径
      templatePath = normalizePath(templatePath);

      // 自动补全 .md 后缀（如果用户没写）
      if (!templatePath.endsWith('.md')) {
        templatePath += '.md';
      }

      // 获取模板文件
      const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
      if (!templateFile || !templateFile.extension || templateFile.extension.toLowerCase() !== 'md') {
        new Notice('模板文件不存在: ' + templatePath);
        return '';
      }

      // 读取模板内容
      let content = await this.app.vault.read(templateFile);
      if (!content) {
        return '';
      }

      // 获取选中日期
      const selectedDate = this.model.selectedDate || new Date();
      const now = new Date();

      // 替换模板变量
      // {{title}} - 笔记标题
      content = content.replace(/\{\{title\}\}/g, title);

      // {{date}} 或 {{date:FORMAT}} - 选中日期
      content = content.replace(/\{\{date(?::([^}]+))?\}\}/g, (match, format) => {
        const fmt = format || this.model.dateFormat || 'YYYY-MM-DD';
        return this.formatDateWithMoment(selectedDate, fmt);
      });

      // {{time}} 或 {{time:FORMAT}} - 当前时间
      content = content.replace(/\{\{time(?::([^}]+))?\}\}/g, (match, format) => {
        const fmt = format || 'HH:mm';
        return this.formatDateWithMoment(now, fmt);
      });

      return content;
    } catch (error) {
      console.error('[NoteCalendar] 获取模板内容失败:', error);
      return '';
    }
  }

  /**
   * 使用 moment.js 格式化日期
   * @param {Date} date - 日期对象
   * @param {string} format - moment.js 格式字符串
   * @returns {string} 格式化后的日期字符串
   */
  formatDateWithMoment(date, format) {
    try {
      if (window.moment) {
        return window.moment(date).format(format);
      }
    } catch (e) {
      console.error('[NoteCalendar] moment格式化失败:', e);
    }
    // fallback: 简单格式化
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return format
      .replace('YYYY', year)
      .replace('MM', month)
      .replace('DD', day)
      .replace('HH', hours)
      .replace('mm', minutes);
  }

  /**
   * 获取字体CSS值
   */
  getFontFamilyValue() {
    const fontMap = {
      'default': 'inherit',
      'microsoft-yahei': 'Microsoft YaHei',
      'simsun': 'SimSun',
      'simhei': 'SimHei',
      'arial': 'Arial',
      'helvetica': 'Helvetica',
      'verdana': 'Verdana',
      'tahoma': 'Tahoma',
      'segoe-ui': 'Segoe UI'
    };
    return fontMap[this.model.fontFamily] || 'inherit';
  }

  /**
   * 应用样式设置
   */
  applyStyles() {
    if (!this.contentEl) return;
    this.contentEl.style.setProperty('--calendar-weekend-color', this.model.weekendColor);
    this.contentEl.style.setProperty('--calendar-primary', this.model.themeColor);
    this.contentEl.style.setProperty('--calendar-bg', this.model.bgColor);
    this.contentEl.style.setProperty('--calendar-font-family', this.getFontFamilyValue());
    this.contentEl.style.setProperty('--calendar-font-size', this.model.fontSize + 'px');
  }

  /**
   * 更新今天按钮的状态
   */
  updateTodayButtonState() {
    if (!this.todayBtn) return;

    const selectedDate = this.model.selectedDate;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let isTodaySelected = false;
    if (selectedDate) {
      const compareDate = new Date(selectedDate);
      compareDate.setHours(0, 0, 0, 0);
      isTodaySelected = compareDate.getFullYear() === today.getFullYear() &&
                     compareDate.getMonth() === today.getMonth() &&
                     compareDate.getDate() === today.getDate();
    }

    const hasSelectedClass = this.todayBtn.classList.contains('calendar-today-btn-selected');

    if (isTodaySelected && !hasSelectedClass) {
      this.todayBtn.classList.add('calendar-today-btn-selected');
    } else if (!isTodaySelected && hasSelectedClass) {
      this.todayBtn.classList.remove('calendar-today-btn-selected');
    }
  }

  /**
   * 渲染日历
   */
  render() {
    if (!this.container) return;

    // 应用样式设置
    this.applyStyles();

    // 更新今天按钮的状态
    this.updateTodayButtonState();

    // 更新头部标题
    this.updateHeader();

    // 更新网格
    this.updateGrid();

    // 更新笔记列表
    this.updateNotesList();
  }

  /**
   * 更新头部
   */
  updateHeader() {
    if (this.titleEl && this.lunarTitleEl) {
      const { year, month } = this.model.getViewDate();
      this.titleEl.textContent = `${year}年 ${month}月`;
      if (this.model.showLunarDate) {
        this.lunarTitleEl.textContent = this.getMonthLunarInfo(year, month);
      } else {
        this.lunarTitleEl.textContent = "";
      }
    }
  }

  async onClose() {
    // 视图关闭时的清理工作
  }
}

/**
 * 设置面板类
 */
class CalendarSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // 添加说明文本
    containerEl.createEl('h2', { text: 'Note Calendar 设置' });

    // 一周起始日设置
    new Setting(containerEl)
      .setName('一周起始日')
      .setDesc('选择日历一周的第一天是周日还是周一')
      .addDropdown(dropdown => dropdown
        .addOption('0', '周日')
        .addOption('1', '周一')
        .setValue(String(this.plugin.settings.startOfWeek))
        .onChange(async (value) => {
          await this.plugin.updateSettings({
            startOfWeek: parseInt(value)
          });
        }));

    // 周末颜色设置
    new Setting(containerEl)
      .setName('周末颜色')
      .setDesc('周六和周日显示的颜色')
      .addColorPicker(colorPicker => colorPicker
        .setValue(this.plugin.settings.weekendColor)
        .onChange(async (value) => {
          await this.plugin.updateSettings({
            weekendColor: value
          });
        }));

    // 主题颜色设置
    new Setting(containerEl)
      .setName('主题颜色')
      .setDesc('今天、选中状态和节假日的显示颜色')
      .addColorPicker(colorPicker => colorPicker
        .setValue(this.plugin.settings.themeColor)
        .onChange(async (value) => {
          await this.plugin.updateSettings({
            themeColor: value
          });
        }));

    // 背景颜色设置
    new Setting(containerEl)
      .setName('背景颜色')
      .setDesc('日历面板的背景颜色')
      .addColorPicker(colorPicker => colorPicker
        .setValue(this.plugin.settings.bgColor)
        .onChange(async (value) => {
          await this.plugin.updateSettings({
            bgColor: value
          });
        }));

    // 字体设置
    new Setting(containerEl)
      .setName('字体')
      .setDesc('选择日历使用的字体')
      .addDropdown(dropdown => dropdown
        .addOption('default', '默认')
        .addOption('microsoft-yahei', '微软雅黑')
        .addOption('simsun', '宋体')
        .addOption('simhei', '黑体')
        .addOption('arial', 'Arial')
        .addOption('helvetica', 'Helvetica')
        .addOption('verdana', 'Verdana')
        .addOption('tahoma', 'Tahoma')
        .addOption('segoe-ui', 'Segoe UI')
        .setValue(this.plugin.settings.fontFamily)
        .onChange(async (value) => {
          await this.plugin.updateSettings({
            fontFamily: value
          });
        }));

    // 字号设置
    new Setting(containerEl)
      .setName('字号')
      .setDesc('设置日历文字大小（10-20px）')
      .addSlider(slider => slider
        .setLimits(10, 20, 1)
        .setValue(this.plugin.settings.fontSize)
        .setDynamicTooltip()
        .onChange(debounce(async (value) => {
          await this.plugin.updateSettings({
            fontSize: Math.round(value)
          });
        }, 300)));

    new Setting(containerEl)
      .setName('是否显示公历假日')
      .setDesc('关闭后不再显示公历假日')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showSolarFestivals)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              showSolarFestivals: value
            });
          });
      });
      new Setting(containerEl)
      .setName('是否显示调休')
      .setDesc('关闭后不再显示调休')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showHolidayMarker)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              showHolidayMarker: value
            });
          });
      });
      new Setting(containerEl)
      .setName('是否显示农历日期')
      .setDesc('关闭后不再显示农历日期，月份，年份')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showLunarDate)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              showLunarDate: value
            });
          });
      });
          new Setting(containerEl)
      .setName('是否显示农历假日')
      .setDesc('关闭后不再显示农历假日')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showLunarFestivals)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              showLunarFestivals: value
            });
          });
      });
          new Setting(containerEl)
      .setName('是否显示农历节气')
      .setDesc('关闭后不再显示农历节气')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showJieQi)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              showJieQi: value
            });
          });
      });
      new Setting(containerEl)
      .setName('显示香港公众假期')
      .setDesc('开启后显示香港公众假期（2026-2027，含耶稣受难节、复活节、佛诞、重阳节等）。数据来自香港政府宪报公告，每年公布后需更新插件')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showHongKongHolidays)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              showHongKongHolidays: value
            });
          });
      });

    // 笔记文件夹路径设置
    new Setting(containerEl)
      .setName('笔记文件夹路径')
      .setDesc('设置扫描笔记的文件夹路径（留空为根目录）')
      .addText(text => text
        .setPlaceholder('例如: Notes')
        .setValue(this.plugin.settings.noteFolderPath)
        .onChange(debounce(async (value) => {
          await this.plugin.updateSettings({
            noteFolderPath: value
          });
        }, 400)));

    // 模板文件路径设置
    new Setting(containerEl)
      .setName('日记模板文件路径')
      .setDesc('创建日记时自动注入的模板文件路径（留空则尝试读取核心"日记"插件的模板设置）。支持 {{date}}、{{date:YYYY-MM-DD}}、{{time}}、{{time:HH:mm}}、{{title}} 变量')
      .addText(text => text
        .setPlaceholder('例如: 模板/日记模板')
        .setValue(this.plugin.settings.templatePath)
        .onChange(debounce(async (value) => {
          await this.plugin.updateSettings({
            templatePath: value
          });
        }, 400)));

    // 默认创建文件夹路径设置
    new Setting(containerEl)
      .setName('默认创建文件夹路径')
      .setDesc('创建笔记时弹出的对话框中默认填充的文件夹路径（留空为根目录，创建时可手动修改）')
      .addText(text => text
        .setPlaceholder('例如: 日记')
        .setValue(this.plugin.settings.defaultCreateFolder)
        .onChange(debounce(async (value) => {
          await this.plugin.updateSettings({
            defaultCreateFolder: value
          });
        }, 400)));

    // 日期格式设置
    new Setting(containerEl)
      .setName('日期格式')
      .setDesc('设置新建笔记的默认日期格式')
      .addDropdown(dropdown => dropdown
        .addOption('YYYY-MM-DD', 'YYYY-MM-DD')
        .addOption('YYYY/MM/DD', 'YYYY/MM/DD')
        .addOption('DD/MM/YYYY', 'DD/MM/YYYY')
        .addOption('MM/DD/YYYY', 'MM/DD/YYYY')
        .setValue(this.plugin.settings.dateFormat || 'YYYY-MM-DD')
        .onChange(async (value) => {
          await this.plugin.updateSettings({
            dateFormat: value
          });
        }));

    // 重新扫描笔记按钮
    new Setting(containerEl)
      .setName('重新扫描笔记')
      .setDesc('点击按钮重新扫描所有笔记')
      .addButton(button => button
        .setButtonText('扫描')
        .onClick(async () => {
          await this.plugin.scanNotes();
        }));

  }
}
