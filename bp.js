import fs from "node:fs"
import plugin from "../../lib/plugins/plugin.js"
import fetch from "node-fetch"
import { Character } from "#miao.models"
import { resolveGsReleaseName } from "../genshin/model/resolveGsReleaseName.js"

const PLUGIN = "genshin-bp"
const TTL_SEC = 3600

const idleTimers = new Map()

let _releaseNamesCache

function timerKey(botId, groupId) {
  return `${botId}:${groupId}`
}

function clearIdleTimer(botId, groupId) {
  const key = timerKey(botId, groupId)
  const t = idleTimers.get(key)
  if (t) clearTimeout(t)
  idleTimers.delete(key)
}

function redisKey(botId, groupId) {
  return `genshin-bp:${botId}:${groupId}`
}

function normalizeBpState(state) {
  if (!state || typeof state !== "object") return null
  if (!state.timeouts?.p1) {
    state.timeouts = {
      p1: { count: 0, seconds: 0 },
      p2: { count: 0, seconds: 0 },
    }
  }
  if (state.pendingCount == null) state.pendingCount = 0
  if (state.pendingSeconds == null) state.pendingSeconds = 0
  return state
}

async function loadStateByKey(botId, groupId) {
  const raw = await redis.get(redisKey(botId, groupId))
  if (!raw) return null
  try {
    return normalizeBpState(JSON.parse(raw))
  } catch {
    return null
  }
}

async function saveStateByKey(botId, groupId, state) {
  await redis.setEx(redisKey(botId, groupId), TTL_SEC, JSON.stringify(state))
}

function releaseCharNames() {
  if (_releaseNamesCache) return _releaseNamesCache
  const set = new Set()
  Character.forEach(
    char => {
      if (char.game === "gs" && char.isRelease) set.add(char.name)
      return true
    },
    "release",
    "gs",
  )
  _releaseNamesCache = set
  return _releaseNamesCache
}

function stripTimeSegment(msg) {
  let timeLimitSec = null
  let rest = (msg || "").trim()
  const m = rest.match(/\b时间\s*(\d+)\s*(?:秒|[sS])?\b/i)
  if (m) {
    timeLimitSec = Math.max(1, parseInt(m[1], 10) || 0)
    rest = rest.replace(m[0], " ").replace(/\s+/g, " ").trim()
  }
  return { rest, timeLimitSec }
}

function parseDefaultBanRaw(rest) {
  const s = (rest || "").trim()
  if (!s) return []
  const m =
    s.match(/^(?:（|\()\s*(?:设置默认ban位|默认ban位)\s*[：:]?\s*(.+?)\s*(?:）|\))$/) ||
    s.match(/^(?:设置默认ban位|默认ban位)\s*[：:]?\s*(.+)$/)
  if (!m) return []
  return m[1]
    .split(/[,，、\s]+/)
    .map(x => x.trim())
    .filter(Boolean)
}

const resolveGsChar = resolveGsReleaseName

/** 批量角色名：空格 / 英文逗号 / 中文逗号、顿号 */
function splitRoleTokens(raw) {
  return String(raw ?? "")
    .split(/[,，、\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

async function getMemberName(e, qq) {
  const id = String(qq)
  if (String(e.user_id) === id) {
    return e.sender?.card || e.sender?.nickname || id
  }
  try {
    const pick = e.group?.pickMember?.(Number(qq) || qq)
    if (pick?.getInfo) {
      const info = await pick.getInfo()
      return info.card || info.nickname || id
    }
  } catch {}
  return id
}

const MIAO_RES_ABS = `${process.cwd()}/plugins/miao-plugin/resources/`

/** 喵喵 meta 角色头像相对路径（与面板等模板一致，供 _miao_path 拼接） */
function miaoCharFaceRel(name) {
  const char = Character.get(name, "gs")
  if (!char?.getImgs || !char.isRelease) return ""
  try {
    const imgs = char.getImgs()
    const raw = imgs.qFace || imgs.face || ""
    const rel = String(raw).replace(/^\//, "")
    if (!rel) return ""
    const full = MIAO_RES_ABS + rel
    if (!fs.existsSync(full)) return ""
    return rel
  } catch {
    return ""
  }
}

function mapCharChips(names) {
  return names.map(name => ({ name, face: miaoCharFaceRel(name) }))
}

function svgAvatarPlaceholder(label) {
  const t = String(label).replace(/[^\d]/g, "").slice(-2) || "?"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="100%" y2="100%"><stop offset="0%" stop-color="#2d3a4f"/><stop offset="100%" stop-color="#1a2332"/></linearGradient></defs><rect width="120" height="120" rx="60" fill="url(#g)"/><text x="60" y="72" text-anchor="middle" fill="#8b9cb3" font-size="26" font-family="sans-serif">${t}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 拉取 QQ 头像并转 data URL，避免 Puppeteer 外链 qlogo 失败 */
async function resolveQqAvatarDataUrl(e, qq) {
  const id = Number(qq) || qq
  const urls = []
  try {
    const m = e.group?.pickMember?.(id)
    if (m && typeof m.getAvatarUrl === "function") {
      const u = await m.getAvatarUrl()
      if (u && typeof u === "string") urls.push(u)
    }
  } catch {}
  urls.push(
    `https://q.qlogo.cn/g?b=qq&s=640&nk=${id}`,
    `https://q.qlogo.cn/g?b=qq&s=0&nk=${id}`,
    `https://q.qlogo.cn/headimg_dl?dst_uin=${id}&spec=640`,
  )
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": ua } })
      if (!res.ok) continue
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim() || "image/jpeg"
      if (!/^image\//i.test(ct)) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 80) continue
      return `data:${ct};base64,${buf.toString("base64")}`
    } catch {}
  }
  return svgAvatarPlaceholder(id)
}

async function loadState(e) {
  return loadStateByKey(e.self_id, e.group_id)
}

async function saveState(e, state) {
  await saveStateByKey(e.self_id, e.group_id, state)
}

async function delState(e) {
  clearIdleTimer(e.self_id, e.group_id)
  await redis.del(redisKey(e.self_id, e.group_id))
}

/** 仅累计「待归属」超时；下一条成功的 ban/pick 记到发送者；若成功 结束bp 则丢弃、不计入统计 */
function recordIdleTimeoutWindow(state) {
  const sec = state.timeLimitSec
  state.pendingCount += 1
  state.pendingSeconds += sec
  state.deadline = state.deadline + sec * 1000
}

function assignPendingTimeoutsTo(state, playerKey) {
  const c = state.pendingCount || 0
  const s = state.pendingSeconds || 0
  if (!c) return
  state.timeouts[playerKey].count += c
  state.timeouts[playerKey].seconds += s
  state.pendingCount = 0
  state.pendingSeconds = 0
}

/**
 * 消息触发时：追赶所有已错过的计时窗口，合并为一条提示
 */
async function flushIdleTimeoutsOnMessage(e, state) {
  if (!state.timeLimitSec || !state.deadline) return 0
  let n = 0
  const now = Date.now()
  while (state.timeLimitSec && now >= state.deadline) {
    recordIdleTimeoutWindow(state)
    n += 1
  }
  if (n > 0) {
    const sec = state.timeLimitSec
    await e.reply(
      n === 1
        ? `已超时（单次计时 ${sec} 秒）`
        : `已超时（连续错过 ${n} 个计时窗口，单次 ${sec} 秒）`,
    )
  }
  return n
}

async function scheduleIdleTimer(botId, groupId) {
  const key = timerKey(botId, groupId)
  clearIdleTimer(botId, groupId)
  const state = await loadStateByKey(botId, groupId)
  if (!state?.timeLimitSec || !state.deadline) return

  let ms = state.deadline - Date.now()
  if (ms < 0) ms = 0

  const run = async () => {
    idleTimers.delete(key)
    const st = await loadStateByKey(botId, groupId)
    if (!st?.timeLimitSec || !st.deadline) return

    if (Date.now() < st.deadline) {
      await scheduleIdleTimer(botId, groupId)
      return
    }

    const sec = st.timeLimitSec
    recordIdleTimeoutWindow(st)
    await saveStateByKey(botId, groupId, st)

    try {
      await Bot.sendGroupMsg(botId, groupId, `已超时（单次计时 ${sec} 秒）`)
    } catch (err) {
      logger.mark(`[genshin-bp] 超时通知失败 ${err}`)
    }

    await scheduleIdleTimer(botId, groupId)
  }

  idleTimers.set(key, setTimeout(run, ms))
}

function pickRandomFrom(arr) {
  if (!arr.length) return null
  return arr[Math.floor(Math.random() * arr.length)]
}

function getAvailableNames(state) {
  const pool = releaseCharNames()
  const allBanned = new Set([...state.defaultBan, ...state.ban1, ...state.ban2])
  const allPicked = new Set([...state.pick1, ...state.pick2])
  return [...pool].filter(n => !allBanned.has(n) && !allPicked.has(n))
}

async function renderBoard(e, state, extra = {}) {
  const available = getAvailableNames(state).sort()
  const p1Name = await getMemberName(e, state.p1)
  const p2Name = await getMemberName(e, state.p2)
  const [p1Face, p2Face] = await Promise.all([
    resolveQqAvatarDataUrl(e, state.p1),
    resolveQqAvatarDataUrl(e, state.p2),
  ])

  let countdownSec = null
  if (state.timeLimitSec && state.deadline) {
    countdownSec = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000))
  }

  const availableShow = available.slice(0, 48)
  const data = {
    p1: state.p1,
    p2: state.p2,
    p1Name,
    p2Name,
    p1Face,
    p2Face,
    timeLimitSec: state.timeLimitSec || 0,
    countdownSec,
    defaultBanRows: mapCharChips(state.defaultBan),
    ban1Rows: mapCharChips(state.ban1),
    ban2Rows: mapCharChips(state.ban2),
    pick1Rows: mapCharChips(state.pick1),
    pick2Rows: mapCharChips(state.pick2),
    available,
    availableShowRows: mapCharChips(availableShow),
    availableMore: Math.max(0, available.length - 48),
    tip: extra.tip || "",
  }

  await e.runtime.render(PLUGIN, "bp/board", data)
}

function bumpDeadline(state) {
  if (state.timeLimitSec) {
    state.deadline = Date.now() + state.timeLimitSec * 1000
  }
}

export class GenshinBp extends plugin {
  constructor() {
    super({
      name: "原神BP",
      dsc: "双人 ban/pick 草稿",
      event: "message",
      priority: 599,
      rule: [
        { reg: /^#开始bp/i, fnc: "startBp" },
        { reg: /^(?:#)?bp帮助\s*$/i, fnc: "bpHelp" },
        { reg: /^(?:#)?结束bp\s*$/i, fnc: "endBp" },
        { reg: /^(?:#)?ban\s*(.*)$/i, fnc: "doBan" },
        { reg: /^(?:#)?pick\s*(.*)$/i, fnc: "doPick" },
      ],
    })
  }

  async bpHelp() {
    await this.e.runtime.render(PLUGIN, "bp/help", {})
    return true
  }

  async startBp() {
    if (!this.e.isGroup) {
      return this.reply("请在群内使用 #开始bp，并 @ 一名对手")
    }
    if (!this.e.at || String(this.e.at) === String(this.e.user_id)) {
      return this.reply("请 @ 一名对手后再发送 #开始bp")
    }

    const existing = await loadState(this.e)
    if (existing) {
      return this.reply("本群已有进行中的 BP，任意一方发送 结束bp 可关闭")
    }

    let rest = this.e.msg.replace(/^#开始bp\s*/i, "").trim()
    const { rest: restNoTime, timeLimitSec } = stripTimeSegment(rest)
    rest = restNoTime

    const rawParts = parseDefaultBanRaw(rest)
    const pool = releaseCharNames()
    const defaultBan = []
    for (const part of rawParts) {
      const name = resolveGsChar(part)
      if (!name) {
        return this.reply(`默认 ban 位无法识别：${part}\n请使用已实装原神角色名或常用别名`)
      }
      if (!pool.has(name)) {
        return this.reply(`默认 ban 位不在可选池：${name}`)
      }
      if (defaultBan.includes(name)) {
        return this.reply(`默认 ban 重复：${name}`)
      }
      defaultBan.push(name)
    }

    const p1 = String(this.e.user_id)
    const p2 = String(this.e.at)
    const now = Date.now()

    const state = {
      botId: this.e.self_id,
      groupId: this.e.group_id,
      p1,
      p2,
      defaultBan: [...defaultBan],
      ban1: [],
      ban2: [],
      pick1: [],
      pick2: [],
      pendingCount: 0,
      pendingSeconds: 0,
      timeLimitSec: timeLimitSec || null,
      deadline: timeLimitSec ? now + timeLimitSec * 1000 : null,
      timeouts: {
        p1: { count: 0, seconds: 0 },
        p2: { count: 0, seconds: 0 },
      },
    }

    await saveState(this.e, state)
    clearIdleTimer(this.e.self_id, this.e.group_id)
    await scheduleIdleTimer(this.e.self_id, this.e.group_id)

    let tip = "自由出手：两名玩家可随时 ban / pick（不写角色名则随机）"
    if (defaultBan.length) tip += `\n已应用默认 ban：${defaultBan.join("、")}`
    if (timeLimitSec) tip += `\n操作时限：${timeLimitSec} 秒（每次操作后重置）`

    await renderBoard(this.e, state, { tip })
    return true
  }

  async endBp() {
    if (!this.e.isGroup) return false
    let state = await loadState(this.e)
    if (!state) {
      return this.reply("当前群没有进行中的 BP")
    }
    if (state.botId == null) {
      state.botId = this.e.self_id
      state.groupId = this.e.group_id
    }
    const uid = String(this.e.user_id)
    if (uid !== state.p1 && uid !== state.p2) {
      return this.reply("只有参与 BP 的两人可以结束")
    }

    clearIdleTimer(state.botId, state.groupId)

    if (state.pick1.length !== state.pick2.length) {
      await scheduleIdleTimer(state.botId, state.groupId)
      return this.reply(
        `当前无法结束：双方 pick 数量需相同（玩家1：${state.pick1.length}，玩家2：${state.pick2.length}）`,
      )
    }

    /** 成功结束：未归属的超时全部作废，不写入任何人统计 */
    state.pendingCount = 0
    state.pendingSeconds = 0

    const p1Name = await getMemberName(this.e, state.p1)
    const p2Name = await getMemberName(this.e, state.p2)

    const lines = ["已结束本局 BP"]
    const t1 = state.timeouts.p1
    const t2 = state.timeouts.p2
    if (t1.count > 0 || t2.count > 0) {
      lines.push("【超时统计】")
      if (t1.count > 0) {
        lines.push(`${p1Name}：超时 ${t1.count} 次，累计 ${t1.seconds} 秒`)
      }
      if (t2.count > 0) {
        lines.push(`${p2Name}：超时 ${t2.count} 次，累计 ${t2.seconds} 秒`)
      }
    }

    await delState(this.e)
    return this.reply(lines.join("\n"))
  }

  async doBan() {
    return this._action("ban")
  }

  async doPick() {
    return this._action("pick")
  }

  async _action(kind) {
    if (!this.e.isGroup) return false

    let state = await loadState(this.e)
    if (!state) {
      return this.reply("当前群没有进行中的 BP，发起人请先 #开始bp 并 @ 对手")
    }
    if (state.botId == null) {
      state.botId = this.e.self_id
      state.groupId = this.e.group_id
    }

    const uid = String(this.e.user_id)
    const isP1 = uid === state.p1
    const isP2 = uid === state.p2
    if (!isP1 && !isP2) {
      return this.reply("只有参与 BP 的两人可以操作")
    }

    clearIdleTimer(state.botId ?? this.e.self_id, state.groupId ?? this.e.group_id)

    const flushed = await flushIdleTimeoutsOnMessage(this.e, state)
    if (flushed > 0) {
      await saveState(this.e, state)
    }

    const m = this.e.msg.match(kind === "ban" ? /^(?:#)?ban\s*(.*)$/i : /^(?:#)?pick\s*(.*)$/i)
    let raw = (m?.[1] ?? "").trim()

    const availableList = getAvailableNames(state)
    if (!availableList.length) {
      return this.reply("可用角色池已空，无法继续 ban/pick")
    }

    const pool = releaseCharNames()
    const opLabel = kind === "ban" ? "Ban" : "Pick"
    let targets = []

    if (!raw) {
      const one = pickRandomFrom(availableList)
      if (!one) return this.reply("可用角色池已空，无法继续 ban/pick")
      targets = [one]
    } else {
      targets = splitRoleTokens(raw)
      if (!targets.length) {
        const one = pickRandomFrom(availableList)
        if (!one) return this.reply("可用角色池已空，无法继续 ban/pick")
        targets = [one]
      }
    }

    const successes = []
    const errors = []
    const seen = new Set()

    for (const token of targets) {
      const name = resolveGsChar(token)
      if (!name) {
        errors.push(`「${token}」无法识别`)
        continue
      }
      if (!pool.has(name)) {
        errors.push(`「${name}」不在可选池`)
        continue
      }
      if (seen.has(name)) continue
      seen.add(name)

      const allBanned = new Set([...state.defaultBan, ...state.ban1, ...state.ban2])
      const allPicked = new Set([...state.pick1, ...state.pick2])
      if (allBanned.has(name) || allPicked.has(name)) {
        errors.push(`「${name}」已被 ban 或 pick`)
        continue
      }

      if (kind === "ban") {
        if (isP1) state.ban1.push(name)
        else state.ban2.push(name)
      } else {
        if (isP1) state.pick1.push(name)
        else state.pick2.push(name)
      }
      successes.push(name)
    }

    if (!successes.length) {
      return this.reply(errors.length ? errors.join("\n") : "没有可执行的操作")
    }

    assignPendingTimeoutsTo(state, isP1 ? "p1" : "p2")
    bumpDeadline(state)

    await saveState(this.e, state)
    await scheduleIdleTimer(state.botId, state.groupId)

    const batchNote = successes.length > 1 ? `批量${opLabel}` : !raw ? `随机${opLabel}` : opLabel
    let tip = `${isP1 ? "玩家1" : "玩家2"} ${batchNote}：${successes.join("、")}`
    if (errors.length) tip += `\n未执行：${errors.join("；")}`

    await renderBoard(this.e, state, { tip })
    return true
  }
}
