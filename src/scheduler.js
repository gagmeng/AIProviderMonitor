'use strict';
const logger = require('./logger');
const { detect } = require('./detector');

/**
 * 调度器：按每个 Provider 的轮循周期调度检测。
 *
 * 设计要点：
 * - 每个 provider 一个绝对计时器，下次触发时间基于「上次检测时间 + 周期」计算，
 *   编辑周期后立即按新周期重排；若已到期则立即补检一次。
 * - 周期未变化时重复调用 schedule() 不会重置已排定的计时器（避免编辑其它字段
 *   或频繁保存导致检测被无限推迟）。
 * - tick 续链同样基于最新配置与上次检测时间，自动补齐错过的周期。
 */
class Scheduler {
  constructor({ concurrency = 4 } = {}) {
    this.timers = new Map();      // id -> { handle, firedAt }
    this.running = new Set();     // provider ids currently checking
    this.queue = [];
    this.active = 0;
    this.concurrency = Math.max(1, concurrency);
    this.handlers = {};           // onResult / onState
    this.stopped = false;
    this.getProvider = null;      // (id) => provider
    this.getGlobal = null;        // () => globalCfg，用于把超时/重试/代理等配置透传给 detector
  }

  setConcurrency(n) { this.concurrency = Math.max(1, n | 0 || 1); }

  on(name, fn) { this.handlers[name] = fn; }

  emit(name, ...args) { const fn = this.handlers[name]; if (fn) fn(...args); }

  _periodOf(provider) {
    return Math.max(5, Number(provider && provider.intervalSec) || 60) * 1000;
  }

  /**
   * 注册/更新一个 provider 的周期调度。
   * - 若该 provider 已有未触发的定时器且周期未变化，保持原定时器不动；
   * - 若周期变化：按「上次检测时间 + 新周期」重排，已到期立即补检；
   * - 若无定时器（新启用/刚删除）：同上。
   */
  schedule(provider) {
    const id = provider.id;
    const existing = this.timers.get(id);
    const newPeriod = this._periodOf(provider);

    // 已有待触发定时器且周期未变 → 不打扰（保持原节奏）
    if (existing && existing.period === newPeriod) {
      return;
    }

    this.cancel(id);

    // 计算 ms 后触发：基于上次检测时间；从未检测过或已到期 → 立即
    const last = Number(provider.checkedAt) || 0;
    let delay = last + newPeriod - Date.now();
    if (delay < 0) delay = 0;
    // 刚完成过一轮检测（几秒内）时，仍给出一个小缓冲，避免紧贴着上一轮重复触发
    if (delay === 0 && Date.now() - last < 1000) delay = 1000;

    this._arm(id, delay, newPeriod);

    if (delay === 0) {
      const name = provider.name || `#${id}`;
      logger.info(`[调度] [${name}] 周期 ${Math.round(newPeriod / 1000)}s 已到期，立即补检`);
    } else if (!existing || existing.period !== newPeriod) {
      const name = provider.name || `#${id}`;
      logger.debug(`[调度] [${name}] 下次检测 ${Math.round(delay / 1000)}s 后（周期 ${Math.round(newPeriod / 1000)}s）`);
    }
  }

  /** 设定定时器并记录计划信息 */
  _arm(id, delay, period) {
    const firedAt = Date.now() + delay;   // 本轮计划触发时刻
    const tick = async () => {
      this.timers.delete(id);   // 触发后先摘除，检测完成后由 _afterCheck 续链
      if (this.stopped) return;
      await this.runCheck(id, { reason: 'auto' });
      this._afterCheck(id, firedAt, period);
    };
    const handle = setTimeout(tick, delay);
    this.timers.set(id, { handle, period });
  }

  /**
   * 一轮自动检测完成后续排下一次。
   * 基于「本轮计划触发时刻 + 周期」续排（而非检测完成时刻），
   * 保证周期节奏稳定，不受检测耗时影响；若本轮（含检测）已超过
   * 一个周期，则立即补检。
   */
  _afterCheck(id, firedAt, prevPeriod) {
    if (this.stopped) return;
    const latest = this.getProvider ? this.getProvider(id) : null;
    if (!latest || latest.enabled === false) return;
    const period = this._periodOf(latest);
    let delay = firedAt + period - Date.now();
    if (delay < 0) delay = 0;
    // 检测刚完成时给 1s 缓冲，避免与手动触发/补检紧贴重复
    if (delay < 1000) delay = 1000;
    this._arm(id, delay, period);
  }

  cancel(id) {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t.handle); this.timers.delete(id); }
  }

  removeAll() { for (const id of [...this.timers.keys()]) this.cancel(id); }

  stop() { this.stopped = true; this.removeAll(); }

  /** 入队一次检测（自动去重：同一 provider 进行中不重复入队） */
  runCheck(id, { reason = 'manual' } = {}) {
    return new Promise((resolve) => {
      if (this.running.has(id) && reason === 'manual') {
        logger.debug(`Provider #${id} 检测进行中，忽略重复触发`);
        return resolve(null);
      }
      this.queue.push({ id, reason, resolve });
      this._drain();
    });
  }

  async _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (this.running.has(job.id)) { job.resolve(null); continue; }
      this.active++;
      this.running.add(job.id);
      this.emit('state');
      this._exec(job).finally(() => {
        this.active--;
        this.running.delete(job.id);
        this.emit('state');
        this._drain();
      });
    }
  }

  async _exec(job) {
    const provider = this.getProvider ? this.getProvider(job.id) : null;
    if (!provider) { job.resolve(null); return; }
    logger.info(`开始检测 [${provider.name}] (${job.reason})`);
    try {
      const globalCfg = this.getGlobal ? this.getGlobal() : {};
      const result = await detect(provider, { globalCfg });
      this.emit('result', provider, result, job.reason);
      job.resolve(result);
    } catch (e) {
      logger.error(`检测异常 [${provider.name}]: ${e.message}`);
      job.resolve(null);
    }
  }

  isRunning(id) { return this.running.has(id); }
  runningList() { return [...this.running]; }
}

module.exports = { Scheduler };
