// 更新器覆盖路径的「先铺新 → 交换 → 再删旧」契约。
// 吸收 NANA7MI0/dsh-purge-go 0.7.1 CHANGELOG 的「归档更新只覆盖、不清理」缺口：
// 旧实现逐条目 rm+cp，中断会停在半升级态，上游删名的旧文件还会残留。
// 全部用临时目录 + 故障注入，不碰宿主、不碰网络。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { overlayPayload } from "../lib/update.js";

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-purge-overlay-test-"));
  const dest = path.join(root, "plugin");
  const payload = path.join(root, "payload");
  await fsp.mkdir(path.join(dest, "lib"), { recursive: true });
  await fsp.writeFile(path.join(dest, "lib", "old.js"), "old");
  await fsp.writeFile(path.join(dest, "lib", "stale.js"), "stale"); // payload 里没有 → 目录交换时清理
  await fsp.writeFile(path.join(dest, "client.js"), "old-client");
  await fsp.writeFile(path.join(dest, "LICENSE"), "keep-me"); // payload 里没有的顶层文件 → 不动
  await fsp.mkdir(path.join(payload, "lib"), { recursive: true });
  await fsp.writeFile(path.join(payload, "lib", "new.js"), "new");
  await fsp.writeFile(path.join(payload, "client.js"), "new-client");
  return { root, dest, payload };
}

const leftovers = async (dest) =>
  (await fsp.readdir(dest)).filter((n) => n.includes(".dsh-purge-stage-") || n.includes(".purge-update-bak"));

test("overlayPayload: 正常覆盖 —— 新条目就位、目录内旧文件清理、无关文件不动、无残留", async () => {
  const { root, dest, payload } = await fixture();
  try {
    const res = await overlayPayload(dest, payload, ["lib", "client.js"]);
    assert.equal(res.swapped.length, 2);
    assert.equal(await fsp.readFile(path.join(dest, "lib", "new.js"), "utf8"), "new");
    assert.equal(fs.existsSync(path.join(dest, "lib", "old.js")), false, "目录交换应清掉旧文件");
    assert.equal(fs.existsSync(path.join(dest, "lib", "stale.js")), false, "上游删名的文件不该残留");
    assert.equal(await fsp.readFile(path.join(dest, "client.js"), "utf8"), "new-client");
    assert.equal(await fsp.readFile(path.join(dest, "LICENSE"), "utf8"), "keep-me", "payload 没有的条目不动");
    assert.deepEqual(await leftovers(dest), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("overlayPayload: A 段（staging）中断 —— 目标目录一个字节没动", async () => {
  const { root, dest, payload } = await fixture();
  try {
    await assert.rejects(
      () => overlayPayload(dest, payload, ["lib", "client.js"], {
        onStep: (label) => {
          if (label.startsWith("stage:")) throw new Error("boom-stage");
        },
      }),
      /boom-stage/,
    );
    assert.equal(await fsp.readFile(path.join(dest, "lib", "old.js"), "utf8"), "old");
    assert.equal(await fsp.readFile(path.join(dest, "lib", "stale.js"), "utf8"), "stale");
    assert.equal(await fsp.readFile(path.join(dest, "client.js"), "utf8"), "old-client");
    assert.deepEqual(await leftovers(dest), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("overlayPayload: B 段（第二个条目交换）中断 —— 已交换条目回滚，目标目录保持原样", async () => {
  const { root, dest, payload } = await fixture();
  try {
    let swaps = 0;
    await assert.rejects(
      () => overlayPayload(dest, payload, ["lib", "client.js"], {
        onStep: (label) => {
          if (label.startsWith("swap:")) {
            swaps += 1;
            if (swaps === 2) throw new Error("boom-swap");
          }
        },
      }),
      /boom-swap/,
    );
    assert.equal(await fsp.readFile(path.join(dest, "lib", "old.js"), "utf8"), "old", "第一个条目应回滚");
    assert.equal(await fsp.readFile(path.join(dest, "lib", "stale.js"), "utf8"), "stale");
    assert.equal(fs.existsSync(path.join(dest, "lib", "new.js")), false, "回滚后不该有新文件");
    assert.equal(await fsp.readFile(path.join(dest, "client.js"), "utf8"), "old-client");
    assert.deepEqual(await leftovers(dest), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("overlayPayload: C 段（cleanup）失败 —— 新版本已就位，只留可回收的备份垃圾", async () => {
  const { root, dest, payload } = await fixture();
  try {
    const res = await overlayPayload(dest, payload, ["lib"], {
      onStep: (label) => {
        if (label.startsWith("cleanup:")) throw new Error("boom-cleanup");
      },
    });
    assert.equal(res.swapped.length, 1);
    assert.equal(await fsp.readFile(path.join(dest, "lib", "new.js"), "utf8"), "new");
    assert.equal(fs.existsSync(path.join(dest, "lib", "stale.js")), false);
    // cleanup 异常被吞：备份留着但不影响功能；下一轮 swap 前会 rm 掉。
    assert.ok((await leftovers(dest)).some((n) => n.includes("purge-update-bak")));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("overlayPayload: 重跑幂等 —— 上一轮留下的备份会在新一轮被清掉", async () => {
  const { root, dest, payload } = await fixture();
  try {
    await overlayPayload(dest, payload, ["lib"], {
      onStep: (label) => {
        if (label.startsWith("cleanup:")) throw new Error("leave-backup");
      },
    });
    assert.ok((await leftovers(dest)).length > 0);
    await overlayPayload(dest, payload, ["lib"]);
    assert.deepEqual(await leftovers(dest), []);
    assert.equal(await fsp.readFile(path.join(dest, "lib", "new.js"), "utf8"), "new");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("overlayPayload: staging 建在 dest 外 —— 成功与中断后 root 下都不留 stage（金鱼 M2）", async () => {
  const { root, dest, payload } = await fixture();
  const rootLeftovers = async () =>
    (await fsp.readdir(root)).filter((n) => n.includes(".dsh-purge-stage-"));
  try {
    await overlayPayload(dest, payload, ["lib"]);
    assert.deepEqual(await rootLeftovers(), []);

    await assert.rejects(
      () => overlayPayload(dest, payload, ["client.js"], {
        onStep: (label) => {
          if (label.startsWith("stage:")) throw new Error("boom-stage");
        },
      }),
      /boom-stage/,
    );
    assert.deepEqual(await rootLeftovers(), [], "中断后 staging 也应被 finally 清掉");
    assert.deepEqual(await leftovers(dest), [], "dest 内不该出现 staging");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("overlayPayload: 同一 dest 并发两次串行化 —— 不互相破坏、无残留（金鱼 M2）", async () => {
  const { root, dest, payload } = await fixture();
  try {
    const [a, b] = await Promise.all([
      overlayPayload(dest, payload, ["lib"]),
      overlayPayload(dest, payload, ["lib"]),
    ]);
    assert.equal(a.swapped.length, 1);
    assert.equal(b.swapped.length, 1);
    assert.equal(await fsp.readFile(path.join(dest, "lib", "new.js"), "utf8"), "new");
    assert.deepEqual(await leftovers(dest), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("overlayPayload: 回滚 rename 失败时错误里带 backup 绝对路径（金鱼 M1）", async () => {
  const { root, dest, payload } = await fixture();
  const origRename = fsp.rename;
  let intercepted = null;
  fsp.rename = async (from, to) => {
    if (String(from).includes(".purge-update-bak") && String(to).endsWith(path.join("plugin", "lib"))) {
      intercepted = from;
      const e = new Error("simulated rollback EBUSY");
      e.code = "EBUSY";
      throw e;
    }
    return origRename(from, to);
  };
  try {
    let err = null;
    try {
      await overlayPayload(dest, payload, ["lib", "client.js"], {
        onStep: (label) => {
          if (label === "swap:client.js") throw new Error("boom-swap");
        },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "应抛出错误");
    assert.ok(intercepted, "回滚 rename 应被拦截到");
    assert.ok(err.message.includes("回滚"), `错误信息应说明回滚不完整: ${err.message}`);
    assert.ok(err.message.includes(".purge-update-bak"), `错误信息应带 backup 绝对路径: ${err.message}`);
  } finally {
    fsp.rename = origRename;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("overlayPayload: 遗留备份是唯一版本时拒绝覆盖且不动备份（金鱼 M3）", async () => {
  const { root, dest, payload } = await fixture();
  try {
    const backupPath = path.join(dest, "package.json.purge-update-bak");
    await fsp.writeFile(path.join(payload, "package.json"), JSON.stringify({ version: "2.0.0" }));
    await fsp.writeFile(backupPath, JSON.stringify({ version: "1.0.0" }));
    // dest 里没有 package.json —— 备份是唯一可读的旧版本（上次回滚失败态）
    await assert.rejects(
      () => overlayPayload(dest, payload, ["package.json"]),
      /唯一回滚副本/,
    );
    assert.equal(await fsp.readFile(backupPath, "utf8"), JSON.stringify({ version: "1.0.0" }), "备份必须原样保留");
    assert.equal(fs.existsSync(path.join(dest, "package.json")), false, "不该覆盖出新的 package.json");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
