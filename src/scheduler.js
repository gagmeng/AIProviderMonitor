'use strict';
const logger = require('./logger');
const { detect } = require('./detector');
const MAX_TIMER_MS = 2147483647;
function clampTimerMs(ms) { return Math.min(MAX_TIMER_MS, Math.max(0, Math.floor(Number(ms) || 0))); }
class Scheduler {
  constructor({ concurrency = 4, detector = detect } = {}) {
    this.timers = new Map(); this.generations = new Map(); this.running = new Set();
    this.controllers = new Map(); this.queued = new Set(); this.queue = []; this.circuits = new Map();
    this.active = 0; this.concurrency = Math.max(1, concurrency); this.handlers = {};
    this.stopped = false; this.paused = false; this.getProvider = null; this.getGlobal = null; this.detector = detector;
  }
  setConcurrency(n) { this.concurrency = Math.min(16, Math.max(1, n | 0 || 1)); this._drain(); }
  on(name, fn) { this.handlers[name] = fn; }
  emit(name, ...args) { if (this.handlers[name]) this.handlers[name](...args); }
  _periodOf(p) { return Math.max(5, Number(p && p.intervalSec) || 60) * 1000; }
  _generation(id) { return this.generations.get(id) || 0; }
  _clearTimer(id) { const t = this.timers.get(id); if (t) clearTimeout(t.handle); this.timers.delete(id); }
  schedule(p) {
    if (this.stopped || p.enabled === false) { this.cancel(p.id); return; }
    const period = this._periodOf(p), old = this.timers.get(p.id);
    if (old && old.period === period) return;
    this.generations.set(p.id, this._generation(p.id) + 1);
    this._armAt(p.id, Math.max(Date.now(), (Number(p.checkedAt) || 0) + period), period, this._generation(p.id));
  }
  _armAt(id, dueAt, period, generation) {
    if (this.stopped || generation !== this._generation(id)) return;
    this._clearTimer(id);
    const wait = this.paused && dueAt <= Date.now() ? 30000 : clampTimerMs(dueAt - Date.now());
    const entry = { dueAt, period, generation, handle: null };
    entry.handle = setTimeout(async () => {
      if (this.timers.get(id) !== entry || generation !== this._generation(id)) return;
      this.timers.delete(id);
      const p = this.getProvider && this.getProvider(id);
      if (this.stopped || !p || p.enabled === false) return;
      if (this.paused || dueAt > Date.now()) { this._armAt(id, dueAt, period, generation); return; }
      await this.runCheck(id, { reason: 'auto' });
      const latest = this.getProvider && this.getProvider(id);
      if (!latest || latest.enabled === false || generation !== this._generation(id)) return;
      this._armAt(id, Math.max(dueAt + this._periodOf(latest), Date.now() + 1000), this._periodOf(latest), generation);
    }, wait);
    this.timers.set(id, entry);
  }
  cancel(id) {
    this._clearTimer(id); this.generations.set(id, this._generation(id) + 1);
    this.queue = this.queue.filter((j) => { if (j.id !== id) return true; this.queued.delete(id); j.resolve(null); return false; });
    if (this.controllers.has(id)) this.controllers.get(id).abort();
  }
  resetCircuit(id) { this.circuits.delete(id); }
  resetAllCircuits() { this.circuits.clear(); }
  removeAll() { for (const id of new Set([...this.timers.keys(), ...this.queued, ...this.running])) this.cancel(id); }
  stop() { this.stopped = true; this.removeAll(); }
  pause() {
    this.paused = true;
    this.queue = this.queue.filter((j) => { if (j.reason === 'manual') return true; this.queued.delete(j.id); j.resolve(null); return false; });
  }
  resume() {
    this.paused = false;
    for (const [id, t] of [...this.timers]) this._armAt(id, t.dueAt, t.period, t.generation);
    this._drain();
  }
  runCheck(id, { reason = 'manual' } = {}) {
    const p = this.getProvider && this.getProvider(id);
    if (this.stopped || !p || this.running.has(id) || this.queued.has(id) ||
      (reason !== 'manual' && (this.paused || p.enabled === false))) return Promise.resolve(null);
    return new Promise((resolve) => { this.queued.add(id); this.queue.push({ id, reason, resolve }); this._drain(); });
  }
  _drain() {
    while (!this.stopped && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift(); this.queued.delete(job.id);
      const p = this.getProvider && this.getProvider(job.id), circuit = this.circuits.get(job.id);
      if (!p || this.running.has(job.id) || (job.reason !== 'manual' && (this.paused || p.enabled === false ||
        (circuit && circuit.openUntil > Date.now())))) { job.resolve(null); continue; }
      const controller = new AbortController(); this.controllers.set(job.id, controller);
      this.running.add(job.id); this.active++; this.emit('state');
      this._exec(job, p, controller).catch((e) => logger.error(e.message)).finally(() => {
        this.controllers.delete(job.id); this.running.delete(job.id); this.active--; this.emit('state'); this._drain();
      });
    }
  }
  async _exec(job, p, controller) {
    try {
      logger.info(`开始检测 [${p.name}] (${job.reason})`);
      const globalCfg = this.getGlobal ? this.getGlobal() : {};
      const result = await this.detector({ ...p }, { globalCfg, signal: controller.signal });
      if (controller.signal.aborted || this.stopped || (this.getProvider && !this.getProvider(job.id))) return;
      if (result.status === 'up') this.circuits.delete(p.id);
      else {
        const c = this.circuits.get(p.id) || { failures: 0, openUntil: 0 }; c.failures++;
        if (c.failures >= Math.max(2, Number(globalCfg.circuitFailThreshold) || 5)) {
          c.openUntil = Date.now() + Math.max(30, Number(globalCfg.circuitOpenSec) || 300) * 1000; c.failures = 0;
        }
        this.circuits.set(p.id, c);
      }
      this.emit('result', this.getProvider ? this.getProvider(job.id) : p, result, job.reason); job.resolve(result);
    } catch (e) { if (!controller.signal.aborted) logger.error(`检测异常 [${p.name}]: ${e.message}`); }
    finally { job.resolve(null); }
  }
  isRunning(id) { return this.running.has(id); }
  runningList() { return [...this.running]; }
  scheduleInfo() { return [...this.timers].map(([id, t]) => ({ id, dueAt: t.dueAt, period: t.period })); }
  circuitInfo() { return [...this.circuits].map(([id, c]) => ({ id, ...c })); }
}
module.exports = { Scheduler, clampTimerMs, MAX_TIMER_MS };
