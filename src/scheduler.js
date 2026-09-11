'use strict';
const logger = require('./logger');
const { detect } = require('./detector');

/**
 * 调度器：按每个 Provider 的轮循周期调度检测。
 * 采用"每个 provider 一个绝对计时器"的方式，支持并发上限与手动触发。
 */
class Scheduler {
  constructor({ concurrency = 4 } = {}) {
    this.timers = new Map();      // id -> timeout handle
    this.running = new Set();     // provider ids currently checking
    this.queue = [];
    this.active = 0;
    this.concurrency = Math.max(1, concurrency);
    this.handlers = {};           // onResult / onState
    this.stopped = false;
    this.getProvider = null;      // (id) => provider
  }

  setConcurrency(n) { this.concurrency = Math.max(1, n | 0 || 1); }

  on(name, fn) { this.handlers[name] = fn; }

  emit(name, ...args) { const fn = this.handlers[name]; if (fn) fn(...args); }

  /** 注册或更新一个 provider 的周期调度（周期变化时重置计时器） */
  schedule(provider) {
    this.cancel(provider.id);
    const period = Math.max(5, Number(provider.intervalSec) || 60) * 1000;
    const tick = async () => {
      if (this.stopped) return;
      await this.runCheck(provider.id, { reason: 'auto' });
      if (this.stopped) return;
      // 重新读取最新配置（周期可能已变更）
      const latest = this.getProvider ? this.getProvider(provider.id) : null;
      if (latest && !latest.enabled === false) {
        const p2 = Math.max(5, Number(latest.intervalSec) || 60) * 1000;
        this.timers.set(provider.id, setTimeout(tick, p2));
      }
    };
    this.timers.set(provider.id, setTimeout(tick, period));
  }

  cancel(id) {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
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
      const result = await detect(provider);
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
