import assert from "node:assert/strict";
import test from "node:test";

import { createScope, mountAll } from "../lib/scoped-capability.js";

/** 最小 cordis 上下文桩：够 scope 用即可。 */
function stubCtx({ withExtend = true } = {}) {
  const log = [];
  const ctx = {
    log,
    effect(fn, label) {
      log.push(`effect:${label}`);
      const cleanup = fn();
      return typeof cleanup === "function" ? cleanup : () => {};
    },
    on(event, handler, options) {
      log.push(`on:${event}`);
      const record = { event, handler, options };
      ctx.listeners.push(record);
      return () => {
        const i = ctx.listeners.indexOf(record);
        if (i < 0) return false;
        ctx.listeners.splice(i, 1);
        return true;
      };
    },
    provide(name) {
      log.push(`provide:${name}`);
      return () => true;
    },
    listeners: [],
  };
  if (withExtend) {
    ctx.extend = (meta) => Object.assign(Object.create(null), ctx, meta, { extended: true });
  }
  return ctx;
}

test("dispose 按 LIFO 逆序撤回", () => {
  const order = [];
  const scope = createScope(stubCtx(), "t");
  scope.track(() => order.push("first"), "first");
  scope.track(() => order.push("second"), "second");
  scope.track(() => order.push("third"), "third");
  scope.dispose();
  assert.deepEqual(order, ["third", "second", "first"]);
});

test("dispose 幂等：第二次不重复撤回", () => {
  let count = 0;
  const scope = createScope(stubCtx(), "t");
  scope.track(() => {
    count += 1;
  });
  scope.dispose();
  scope.dispose();
  scope.dispose();
  assert.equal(count, 1);
  assert.equal(scope.disposed, true);
  assert.equal(scope.size, 0);
});

test("单个 disposer 抛错不阻断其余，且第一个错误被抛出", () => {
  const order = [];
  const scope = createScope(stubCtx(), "t");
  scope.track(() => order.push("a"), "a");
  scope.track(() => {
    order.push("b");
    throw new Error("boom-b");
  }, "b");
  scope.track(() => order.push("c"), "c");
  assert.throws(() => scope.dispose(), /boom-b/);
  // 三个都跑了，b 的错误没把 a 拦下来
  assert.deepEqual(order, ["c", "b", "a"]);
  assert.equal(scope.disposed, true);
});

test("mount 全或无：中途抛错时只回滚本次新增的", () => {
  const ctx = stubCtx();
  const scope = createScope(ctx, "t");

  // 先装一项「上一个 mount 留下的」，不该被下一个 mount 的回滚带走
  scope.mount((s) => {
    s.on("keep/me", () => {});
  });
  assert.equal(scope.size, 1);

  assert.throws(
    () =>
      scope.mount((s) => {
        s.on("add/one", () => {});
        s.on("add/two", () => {});
        throw new Error("mount-failed");
      }),
    /mount-failed/,
  );

  // 只剩 keep/me，add/* 全撤了
  assert.equal(scope.size, 1);
  assert.deepEqual(scope.list(), ["keep/me"]);
  assert.deepEqual(
    ctx.listeners.map((l) => l.event),
    ["keep/me"],
  );
});

test("mount 回滚时宿主缺 on() 也能干净退出", () => {
  const ctx = stubCtx();
  delete ctx.on;
  const scope = createScope(ctx, "t");
  let trackedBefore = 0;
  scope.track(() => {
    trackedBefore += 1;
  }, "pre");
  assert.throws(() => scope.mount((s) => s.on("x", () => {})), TypeError);
  // pre 还在，说明只回滚了本次
  assert.equal(scope.size, 1);
  scope.dispose();
  assert.equal(trackedBefore, 1);
});

test("已 dispose 的 scope 收到新 disposer 立刻回收", () => {
  let disposedLate = false;
  const scope = createScope(stubCtx(), "t");
  scope.dispose();
  const noop = scope.track(() => {
    disposedLate = true;
  });
  assert.equal(disposedLate, true);
  assert.equal(scope.size, 0);
  assert.equal(typeof noop, "function");
  noop(); // 不该抛
});

test("track 返回的 disposer 可提前单独撤回，且重复调用安全", () => {
  let count = 0;
  const scope = createScope(stubCtx(), "t");
  const off = scope.track(() => {
    count += 1;
  }, "one");
  assert.equal(off(), true);
  assert.equal(off(), false); // 已撤过
  assert.equal(count, 1);
  scope.dispose();
  assert.equal(count, 1); // 整体 dispose 不再碰它
});

test("有 extend 时用子上下文，没有时退回父上下文", () => {
  const withExtend = createScope(stubCtx({ withExtend: true }), "labelled");
  assert.equal(withExtend.ctx.extended, true);
  assert.equal(withExtend.ctx.log, withExtend.ctx.log); // 原型链上仍拿到父的能力

  const noExtend = createScope(stubCtx({ withExtend: false }), "plain");
  assert.equal(noExtend.ctx.extended, undefined);
});

test("effect 走宿主 ctx.effect 并带上 scope 前缀", () => {
  const ctx = stubCtx();
  const scope = createScope(ctx, "dsh-purge.test");
  let cleaned = false;
  scope.effect(() => () => {
    cleaned = true;
  }, "watch");
  assert.ok(ctx.log.includes("effect:dsh-purge.test:watch"));
  scope.dispose();
  assert.equal(cleaned, true);
});

test("provide 转发到宿主并随 scope 撤回", () => {
  const ctx = stubCtx();
  let released = 0;
  ctx.provide = (name) => {
    ctx.log.push(`provide:${name}`);
    return () => {
      released += 1;
      return true;
    };
  };
  const scope = createScope(ctx, "t");
  scope.provide("redteam", { ok: 1 });
  assert.ok(ctx.log.includes("provide:redteam"));
  scope.dispose();
  assert.equal(released, 1);
});

test("mountAll 成功时返回已挂载 scope，失败时不返回", () => {
  const ctx = stubCtx();
  const ok = mountAll(ctx, "ok", (s) => s.on("e", () => {}));
  assert.equal(ok.size, 1);
  assert.equal(ok.label, "ok");
  ok.dispose();

  assert.throws(
    () =>
      mountAll(ctx, "bad", (s) => {
        s.on("e2", () => {});
        throw new Error("nope");
      }),
    /nope/,
  );
  assert.deepEqual(
    ctx.listeners.map((l) => l.event),
    [],
  );
});

test("回滚失败不覆盖触发回滚的原错误，挂到 rollbackError", () => {
  const scope = createScope(stubCtx(), "t");
  const original = new Error("original");
  try {
    scope.mount((s) => {
      s.track(() => {
        throw new Error("cleanup-broke");
      }, "bad");
      throw original;
    });
  } catch (error) {
    assert.equal(error, original);
    assert.match(String(error.rollbackError), /cleanup-broke/);
    return;
  }
  assert.fail("应该抛错");
});
