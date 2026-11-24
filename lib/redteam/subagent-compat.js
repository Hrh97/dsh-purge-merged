/**
 * 子代理注册表兼容层（0.2.2-rc.4+ 的 listDescendants 与旧版 listChildren）。
 *
 * 金鱼审查 M3：这段逻辑原先在 `tools.js`（liveRunningChildren）和
 * `ui.js`（listDirectChildren）各写一份，且错误语义不同 —— 一份返回
 * `{available:false,error}`，一份返回 `[]`。宿主 rc 再改一次 depth 语义，
 * 改一处忘另一处就是新 bug。抽到这里，两边同源。
 *
 * 语义（宿主实测，rc.5）：
 *   - rc.4 起 `SubagentRuntime` 只暴露 `listDescendants(rootId, signal)`，
 *     返回**整棵子树**；直接子那一层 `depth === 1`。
 *   - 旧版 `listChildren(rootId)` 只返回直接子，行的 `depth` 字段不存在，
 *     所以 depth 缺失时不按层过滤（否则会把所有行都滤掉）。
 *   - `kind === 'child'` 是两条通道共有的行类型；其它 kind（teammate 等）不算并发子会话。
 */

/**
 * 列某个会话的直接子会话行（已过滤 kind==='child' 与 depth）。
 * @param {object|null|undefined} subagents 宿主 subagents 注册表
 * @param {string} rootId
 * @returns {Promise<{available: boolean, rows: Array, error?: string}>}
 */
export async function listDirectChildRows(subagents, rootId) {
  if (subagents === undefined || subagents === null) {
    return { available: false, rows: [], error: 'subagents 注册表不可用' }
  }
  const hasLegacy = typeof subagents.listChildren === 'function'
  const hasDescendants = typeof subagents.listDescendants === 'function'
  if (!hasLegacy && !hasDescendants) {
    return {
      available: false,
      rows: [],
      error: 'subagents 注册表不可用（无法核对实际并发数，只能按预留计数）',
    }
  }
  try {
    const entries = hasLegacy
      ? await subagents.listChildren(rootId)
      : await subagents.listDescendants(rootId)
    const rows = (Array.isArray(entries) ? entries : []).filter(
      (e) => e && e.kind === 'child' && (hasLegacy || e.depth === undefined || e.depth === 1),
    )
    return { available: true, rows }
  } catch (error) {
    return {
      available: false,
      rows: [],
      error: '列子会话失败：' + (error && error.message ? error.message : String(error)),
    }
  }
}

/** 子会话显示名：label 优先，其次 name，最后退回 id。 */
export function childLabel(k) {
  return k.label || k.name || String(k.id)
}
