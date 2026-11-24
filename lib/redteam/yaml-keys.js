/**
 * 红队预设 YAML 里「按 key 删整块」的共享实现。
 *
 * 金鱼审查 M3：`stripToolFilter`（installPreset 自愈链）与
 * `migrateSubagentConfigKeys`（旧预设迁移）各自写了一份 toolFilter 块删除，
 * 且对「块内空行」语义不一致 —— 前者把空行当块边界保留，后者把空行也删掉。
 * 今天靠 installPreset 先跑 stripToolFilter 掩盖了差异，谁删谁就是行为变化。
 * 抽到这里，两边同源，语义只有一个。
 */

/**
 * 删掉 `key:` 开头的一整块（含所有缩进更深的子行）。
 *
 * 空行处理（金鱼审查 M3 的争议点，这里定案）：YAML 里空行**不结束**一个块 ——
 * 空行之后只要还是更深缩进的内容，就仍属于该 key。所以块内空行跟着一起删；
 * 只有当空行之后的第一条非空行缩进不再更深时，块才算结束，那些空行原样保留
 * （它们是块与后续兄弟键之间的分隔）。旧的两份实现一份按「空行即结束」处理
 * （会漏删 `- read` 这类空行后的列表项），一份按「空行也删」处理（会吃掉
 * 兄弟键前的分隔空行）—— 都不对，统一成这套。
 *
 * @param {string} text  YAML 原文
 * @param {string} key   要删的顶层键名（如 "toolFilter"）
 * @returns {{ text: string, changed: boolean }}
 */
export function stripYamlKeyBlock(text, key) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let skipIndent = null
  let changed = false
  let pendingBlanks = []
  const blockRe = new RegExp(`^(\\s*)${key}:\\s*(?:#.*)?$`)
  const inlineRe = new RegExp(`^\\s*${key}:\\s+\\S`)
  for (const line of lines) {
    if (skipIndent !== null) {
      if (line.trim() === '') {
        // 块内空行：先攒着，等看到下一条非空行再决定归属。
        pendingBlanks.push(line)
        continue
      }
      const indent = (/^(\s*)/.exec(line) || ['', ''])[1].length
      if (indent > skipIndent) {
        // 空行之后仍更深缩进 = 还在块内，连攒下的空行一起删。
        changed = true;
        pendingBlanks = []
        continue
      }
      // 块结束：攒下的空行原样吐回。
      for (const b of pendingBlanks) out.push(b)
      pendingBlanks = []
      skipIndent = null
    }
    const block = blockRe.exec(line)
    if (block) {
      skipIndent = block[1].length
      changed = true
      continue
    }
    if (inlineRe.test(line)) {
      changed = true
      continue
    }
    out.push(line)
  }
  // 文件末尾还在块内：攒的空行属于块尾，丢掉。
  if (skipIndent !== null && pendingBlanks.length > 0) changed = true
  return { text: out.join('\n'), changed }
}

/**
 * 删掉单行标量键（如 `backgroundMode: continuable`）。
 *
 * @param {string} text
 * @param {string} key
 * @returns {{ text: string, changed: boolean }}
 */
export function stripYamlScalarKey(text, key) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let changed = false
  const re = new RegExp(`^\\s*${key}:\\s*\\S+\\s*(?:#.*)?$`)
  for (const line of lines) {
    if (re.test(line)) {
      changed = true
      continue
    }
    out.push(line)
  }
  return { text: out.join('\n'), changed }
}
