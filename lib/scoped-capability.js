/**
 * 可逆能力缝 / reversible capability scope
 * ======================================
 *
 * 为什么要有这一层
 * ----------------
 * `apply(ctx)` 现在是「一路往下 try/catch」：每一项各自兜错，前面装好的不回收。
 * 结果是一个半挂载状态 —— 第 12 项抛了，第 1..11 项的 `agent/pre-step` 钩子还在
 * 跑，而且没人知道该不该撤。这在宿主侧表现成「插件偶尔只生效一半，重启就好」，
 * 是最难复现的一类现场。
 *
 * 上游 tang19-chao/dsh-plugin-evo-harness 用的是 `ctx.fork()`。**本机宿主的
 * cordis 4.0.5 没有 fork**，只有：
 *
 *   ctx.extend(meta)      子上下文，原型继承，父不变
 *   ctx.isolate(name, l)  服务作用域隔离
 *   ctx.intercept(name,c) 拦截服务调用
 *   ctx.effect(fn, label) 聚合 disposer（fiber 级联回收）
 *   ctx.fiber             current fiber
 *
 * 所以这一层不用 fork，用 `extend` 造子上下文 + 自己记账。`extend` 出来的子 ctx
 * 和父共享同一个 fiber，注册仍走 fiber 的 `effect`，因此**插件卸载时照样级联回收**；
 * scope 只是额外给出一层「能单独撤回」的边界。
 *
 * 三条硬语义
 * ----------
 * 1. **LIFO 撤回**：后装的先撤。钩子之间有依赖（后装的往往引用先装的资源），
 *    正序撤会把依赖先抽掉。
 * 2. **撤回不中断**：某个 disposer 抛了，剩下的照样撤完，最后把第一个错误抛出去。
 *    「一个坏 disposer 导致全部泄漏」比那个错误本身严重得多。
 * 3. **幂等**：`dispose()` 调两次是安全的；已 dispose 的 scope 再 `track()` 进来的
 *    东西立刻就地回收，不留悬挂。
 *
 * 用法
 * ----
 *   const scope = createScope(ctx, "dsh-purge.redteam");
 *   try {
 *     scope.mount((s) => {
 *       s.on("agent/pre-step", hook, { global: true });
 *       s.provide("redteam", store);
 *       s.track(() => store.close());
 *     });
 *   } catch {
 *     // 这里出来时 scope 已经是空的：全或无
 *   }
 *   // 需要时
 *   scope.dispose();
 *
 * @module dsh-purge/scoped-capability
 */

/** 打在子上下文上的标签，只为调试/日志能认出「这是哪个 scope 的 ctx」。 */
const SCOPE_LABEL = Symbol.for("dsh-purge.scope.label");

/**
 * 建一个可逆能力缝。
 *
 * @param {object} ctx Cordis 上下文；没有 `extend` 时退化成直接用父 ctx。
 * @param {string} [label] 用于日志/排障的作用域名。
 * @returns {object} scope
 */
export function createScope(ctx, label = "scope") {
  /** @type {Array<{dispose: Function, name: string}>} */
  const entries = [];
  let disposed = false;

  // extend 是可选能力：老宿主 / 测试桩可能只有 effect 没有 extend。
  // 拿不到子上下文时仍然能用 —— 记账逻辑不依赖它，只是少了 label 与原型隔离。
  let child = ctx;
  try {
    if (ctx && typeof ctx.extend === "function") {
      child = ctx.extend({ [SCOPE_LABEL]: label });
    }
  } catch {
    child = ctx;
  }

  const runOne = (entry) => {
    try {
      const result = entry.dispose();
      // cordis 的 disposer 返回 true 表示「当时还挂着、已撤掉」，undefined 表示本来就没挂。
      // 两者都算成功，这里不做区分。
      return result;
    } catch (error) {
      return { error };
    }
  };

  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    // splice 一次性取走，避免 dispose 过程中有人再 track 进来造成边遍历边改。
    const pending = entries.splice(0, entries.length);
    let firstError = null;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const outcome = runOne(pending[i]);
      if (outcome && outcome.error && !firstError) firstError = outcome.error;
    }
    if (firstError) throw firstError;
  };

  /**
   * 记账一条 disposer。返回值是包装后的 disposer（可提前单独撤）。
   * 已 dispose 的 scope 收到新 disposer 会立刻执行它并返回 no-op。
   */
  const track = (dispose, name = "anonymous") => {
    if (typeof dispose !== "function") return () => {};
    if (disposed) {
      // 迟到的东西立刻回收 —— 否则就是一条静默泄漏。
      try {
        dispose();
      } catch {
        /* 迟到 disposer 的失败没有接收方，只能吞掉 */
      }
      return () => {};
    }
    const entry = { dispose, name };
    entries.push(entry);
    return () => {
      const index = entries.indexOf(entry);
      if (index < 0) return false; // 已经撤过（或 scope 已整体撤过）
      entries.splice(index, 1);
      const outcome = runOne(entry);
      if (outcome && outcome.error) throw outcome.error;
      return true;
    };
  };

  const scope = {
    label,
    /** 子上下文。挂东西时优先用它，拿不到 extend 时就是父 ctx 本身。 */
    ctx: child,
    get disposed() {
      return disposed;
    },
    get size() {
      return entries.length;
    },
    /** 当前未撤的条目名，排障用。 */
    list() {
      return entries.map((entry) => entry.name);
    },
    track,

    /**
     * 挂一条 effect。宿主有 `ctx.effect` 就走它（fiber 级联 + 诊断标签），
     * 没有就只记账 —— 调用方拿到的是同一套撤回语义。
     */
    effect(execute, name = "effect") {
      if (child && typeof child.effect === "function") {
        return track(child.effect(execute, `${label}:${name}`), name);
      }
      let cleanup;
      try {
        cleanup = execute();
      } catch (error) {
        throw error;
      }
      return track(typeof cleanup === "function" ? cleanup : () => {}, name);
    },

    /** 挂一条事件监听。宿主不认这个事件名时直接抛，由 mount 负责回滚。 */
    on(event, handler, options, name = event) {
      if (!child || typeof child.on !== "function") {
        throw new TypeError(`scope ${label}: 上下文没有 on()，挂不了 ${event}`);
      }
      return track(child.on(event, handler, options), name);
    },

    /** 挂一个服务。宿主没有 provide 时抛，由 mount 回滚。 */
    provide(serviceName, value, name = `provide:${serviceName}`) {
      if (!child || typeof child.provide !== "function") {
        throw new TypeError(`scope ${label}: 上下文没有 provide()，挂不了 ${serviceName}`);
      }
      return track(child.provide(serviceName, value), name);
    },

    /**
     * 全或无地挂一批能力。
     *
     * `fn` 抛错时，本次已经 track 进来的条目全部撤回，然后把错误原样抛出 ——
     * 调用方看到的是一个干净的 scope，而不是半挂载。
     */
    mount(fn) {
      const before = entries.length;
      try {
        return fn(scope);
      } catch (error) {
        // 只撤本次 mount 新增的部分：之前就装好的东西不归这次调用负责。
        const added = entries.splice(before, entries.length - before);
        let firstError = null;
        for (let i = added.length - 1; i >= 0; i -= 1) {
          const outcome = runOne(added[i]);
          if (outcome && outcome.error && !firstError) firstError = outcome.error;
        }
        // 回滚本身的失败不该盖掉触发回滚的那个错误 —— 挂到 error.cause 上带走。
        if (firstError && !error.rollbackError) {
          try {
            error.rollbackError = firstError;
          } catch {
            /* 冻结的 error 对象，忽略 */
          }
        }
        throw error;
      }
    },

    /** 撤回一切。幂等；不中断；最后抛第一个错误。 */
    dispose: disposeAll,
  };

  return scope;
}

/**
 * 把一串「装一项就 catch 一次」的调用包成全或无。
 *
 * 专为 `apply()` 里那种写法准备的过渡工具：
 *
 *   const scope = createScope(ctx, "dsh-purge");
 *   scope.mount((s) => { s.on(...); s.on(...) });
 *
 * 与直接写 `ctx.on` 的区别只有一点，但是关键的一点：中途抛错时不留半挂载。
 *
 * @param {object} ctx
 * @param {string} label
 * @param {(scope: object) => void} fn
 * @returns {object} 已挂载的 scope（调用方负责在卸载时 dispose）
 */
export function mountAll(ctx, label, fn) {
  const scope = createScope(ctx, label);
  scope.mount(fn);
  return scope;
}
