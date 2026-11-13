// 更新通道（stable / beta）的纯逻辑断言。
//
// 背景：2026-11-13 把更新源从两个 404 的上游换成 Hrh97/dsh-purge-merged 之后，
// fork 上没有 beta 分支，`checkUpdate()` 的 `lanes.beta.hasRemote` 变成 false，
// 切到测试通道会直接报「还没有测试版」。beta 分支建回来之后这些行为需要被钉住：
//   - 测试通道只认 beta 分支头，历史 beta/rc 标签一律不列（lib/update.js:134 的契约）
//   - 版本比较必须是「1.2.0-beta.1 < 1.2.0」，否则测试版永远盖不掉正式版
//   - ref 白名单必须挡住路径穿越形态（beta/../master 之类）
// 这些函数不碰网络也不碰磁盘，全部可以直接 import。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hideListedVersion,
  normalizeChannel,
  resolveHeadSha,
  safeUpdateRef,
  versionIsNewer,
} from "../lib/update.js";

test("versionIsNewer：补丁位/次版本位/主版本位逐级比较", () => {
  assert.equal(versionIsNewer("1.2.1", "1.2.0"), true);
  assert.equal(versionIsNewer("1.3.0", "1.2.9"), true);
  assert.equal(versionIsNewer("2.0.0", "1.99.99"), true);
  assert.equal(versionIsNewer("1.2.0", "1.2.0"), false);
  assert.equal(versionIsNewer("1.2.0", "1.2.1"), false);
});

test("versionIsNewer：预发布版低于同号正式版", () => {
  assert.equal(versionIsNewer("1.2.0-beta.1", "1.2.0"), false);
  assert.equal(versionIsNewer("1.2.0", "1.2.0-beta.1"), true);
  assert.equal(versionIsNewer("1.2.0-beta.2", "1.2.0-beta.1"), true);
});

test("versionIsNewer：空 remote 永远不算更新，空 local 永远算更新", () => {
  assert.equal(versionIsNewer("", "1.2.0"), false);
  assert.equal(versionIsNewer("1.2.0", ""), true);
});

test("normalizeChannel：只有 beta 走测试通道，其余一律 stable", () => {
  assert.equal(normalizeChannel("beta"), "beta");
  assert.equal(normalizeChannel("BETA"), "beta");
  assert.equal(normalizeChannel("stable"), "stable");
  assert.equal(normalizeChannel(""), "stable");
  assert.equal(normalizeChannel(undefined), "stable");
  assert.equal(normalizeChannel("nightly"), "stable");
});

test("safeUpdateRef：只放行 master / beta / 版本号 / 提交号", () => {
  for (const ok of ["master", "beta", "v1.2.0", "1.2.0", "v1.2.0-beta.1", "cf0c0be", "a".repeat(40)]) {
    assert.equal(safeUpdateRef(ok), ok, `应放行 ${ok}`);
  }
  for (const bad of ["", "  ", "beta/../master", "../../etc/passwd", "master;rm -rf /", "refs/heads/beta"]) {
    assert.equal(safeUpdateRef(bad), "", `应拒绝 ${JSON.stringify(bad)}`);
  }
});

// 2026-11-13：网络抖动不能把 lane 判成「分支不存在」。
// api.github.com / github.com 在本机都是间歇可达，remoteHeadSha 两个源同时空过一次，
// listRemoteVersions 就漏掉那条 lane，面板显示「还没有测试版」，切通道直接失败。
test("resolveHeadSha：api 优先、atom 兜底、都空时回落到上次成功的 sha", () => {
  const full = "a".repeat(40);
  const cached = "b".repeat(40);
  assert.equal(resolveHeadSha(full, "", cached), full);
  assert.equal(resolveHeadSha("", full, cached), full);
  assert.equal(resolveHeadSha(full, cached, cached), full);
  assert.equal(resolveHeadSha("", "", cached), cached, "两个源都空时必须回落到缓存");
  assert.equal(resolveHeadSha("", "", ""), "", "没有缓存时返回空串");
  assert.equal(resolveHeadSha(undefined, undefined, undefined), "");
});

test("hideListedVersion：beta 分支头保留，历史 beta 标签隐藏", () => {
  // 分支头（checkUpdate 里以 ref=beta / channel=beta 构造）
  assert.equal(hideListedVersion({ id: "beta", ref: "beta", channel: "beta" }), false);
  // 历史标签
  assert.equal(hideListedVersion({ id: "v1.1.23-beta.1", ref: "v1.1.23-beta.1", channel: "beta" }), true);
  assert.equal(hideListedVersion({ id: "v1.1.24-rc.1", ref: "v1.1.24-rc.1" }), true);
  // 正式标签
  assert.equal(hideListedVersion({ id: "v1.2.0", ref: "v1.2.0", channel: "stable" }), false);
  // 已撤回的 1.1.11-beta 系
  assert.equal(hideListedVersion({ id: "v1.1.11-beta.2", ref: "v1.1.11-beta.2" }), true);
});
