import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isInside, resolvePublic } from './scripts/paths.mjs'
import { ebur128Args, loudnessGain, loudnessStatus, parseLoudness } from './scripts/loudness.mjs'
import { applyExportOutput } from './scripts/export-progress.mjs'

/** 上传落盘:写草稿 → 誊正。两件事必须守住 ——
 *
 *  一、草稿名要唯一。以前草稿固定叫「素材名.part」,同一个素材传两遍(前一遍还没传完
 *  又点了一次)时两次写的是同一份草稿,先完成的把它改名拿走,后完成的 renameSync 抛
 *  ENOENT。Mac 和 Windows 上都栽过这个坑。
 *
 *  二、誊正失败不许把服务带走。这个异常在流的回调里,中间件外面的 try/catch 兜不住,
 *  Vite 也没注册 uncaughtException —— 于是整个开发服务器进程直接退出。页面还在内存里,
 *  看着一切正常,但后台没了,此后每一次导入都失败。用户看到的就是这一幕。
 */
let uploadSeq = 0
function saveUpload(
  req: IncomingMessage,
  res: ServerResponse,
  dest: string,
  urlPath: string,
) {
  const tmp = `${dest}.${process.pid}-${Date.now()}-${++uploadSeq}.part`
  const ws = fs.createWriteStream(tmp)
  let settled = false
  // 所有出口都走这一个函数,而且整个包在 try 里。
  // 第二条守则的教训是「流回调里抛出的异常没人接」—— 那就不许任何一行裸奔:
  // rmSync 的 force 只忽略「文件不存在」,Windows 上文件被杀毒/索引器占着时照样抛 EPERM,
  // 以前 catch 里那句 rmSync 就是这么把服务带走的。
  const reply = (code: number, body: Record<string, unknown>) => {
    if (settled) return
    settled = true
    try {
      if (code !== 200) fs.rmSync(tmp, { force: true })
    } catch (e) {
      console.error(`[upload] 草稿删不掉(留着,下次启动再清):${tmp}`, e)
    }
    try {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    } catch (e) {
      console.error('[upload] 回应失败(多半是浏览器那头已断开):', e)
    }
  }
  // 先把写流关干净、等它真的关掉,再删草稿:Windows 上文件句柄还开着时删不掉
  const fail = (why: string) => {
    const done = () => reply(500, { ok: false, error: why })
    if (ws.closed) done()
    else {
      ws.once('close', done)
      ws.destroy()
    }
  }
  // 浏览器那头中途断开(刷新 / 关标签页 / 断网):pipe 只会解绑,finish 和 error 都不会来,
  // 草稿会永远留在磁盘上,而且改成唯一草稿名之后每断一次就多留一份。这里自己收尾。
  req.on('close', () => {
    if (!req.complete) fail('上传中断')
  })
  req.on('error', (e) => fail(String(e)))
  ws.on('error', (e) => fail(String(e)))
  ws.on('finish', () => {
    void (async () => {
      try {
        await renameWithRetry(tmp, dest)
        // 地址带上文件的修改时间:同名素材换了新版,地址跟着变,浏览器才会去拿新的。
        // 不带的话地址一个字都没变,页面会一直显示旧素材 —— 而导出的成片却是新的。
        const v = Math.floor(fs.statSync(dest).mtimeMs)
        // 两个接口的字段名不一样(/api/media 取 url,/api/upload-demo 取 src),都给,各取各的
        reply(200, { ok: true, url: `${urlPath}?v=${v}`, src: `${urlPath}?v=${v}` })
      } catch (e) {
        fail(`写入失败:${e}`)
      }
    })()
  })
  req.pipe(ws)
}

/**
 * 草稿誊正,失败了等一下再试。
 * Windows 上杀毒/索引器会短暂占住刚写完的文件,改名报 EPERM/EBUSY,过几百毫秒基本都能过。
 * 以前这里的退路是 copyFileSync:草稿和目标永远在同一个目录,「跨盘」根本不会发生;
 * 文件被占时复制一样失败;真跑起来还是几百 MB 的同步复制,会把单线程的服务卡死几十秒。
 */
async function renameWithRetry(tmp: string, dest: string) {
  const waits = [0, 200, 500, 1000]
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]))
    try {
      fs.renameSync(tmp, dest)
      return
    } catch (e) {
      if (i === waits.length - 1) throw e
    }
  }
}

/** 导出透明动效层:POST /api/export → 起无头 Chrome 逐帧渲染 PNG 序列到 exports/ */
/** 音效:public/sfx/ 里放了同名文件就用它,没放就用随仓库附带的 CC0 默认音效(public/sfx-default/)。
 *  默认音效单独放一个文件夹,是为了不和你自己放进 public/sfx/ 的文件撞名 —— 撞名的话 git pull 会直接失败。 */
function sfxFallback(): Plugin {
  return {
    name: 'sfx-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/sfx\/([^/?#]+\.mp3)(?:[?#].*)?$/.exec(req.url ?? '')
        if (!m) return next()
        let name: string
        try { name = path.basename(decodeURIComponent(m[1])) } catch { return next() }
        const pub = path.join(server.config.root, 'public')
        if (fs.existsSync(path.join(pub, 'sfx', name))) return next()
        const fallback = path.join(pub, 'sfx-default', name)
        if (!fs.existsSync(fallback)) return next()
        res.setHeader('Content-Type', 'audio/mpeg')
        fs.createReadStream(fallback).pipe(res)
      })
    },
  }
}

function overlayExport(): Plugin {
  let busy = false
  // 导出进度(GET /api/export-status 轮询用):从脚本 stdout 解析
  let prog: {
    running: boolean
    stage: string // prep | extract | frames | mov | webm | sfx | final | done
    frame: number
    total: number
    finalPct?: number // 成片 MP4 合成进度(0–100)
    finalOnly?: boolean // 只导成片 MP4(没有 MOV/WebM 阶段,进度条按这个分配)
    etaSec?: number // 导出脚本算好的「渲染帧还要多少秒」(截图帧和只推时钟的帧分开计时)
    ok?: boolean
  } = { running: false, stage: 'done', frame: 0, total: 0 }
  return {
    name: 'overlay-export',
    configureServer(server) {
      // 导入的视频落盘成一个真实路径:blob 地址刷新即失效,每次都要重新导入。
      // 存进 public/_media/ 之后,刷新后按 URL 自动恢复;这个路径无头 Chrome 也能读,
      // 所以它同时可以当运镜卡的「口播视频」用。
      server.middlewares.use('/api/media', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method !== 'POST') { res.statusCode = 405; res.end('{"ok":false}'); return }
        const raw = String(req.headers['x-filename'] ?? 'video')
        // 文件名只留安全字符,防止 ../ 之类写到目录外
        const safe = decodeURIComponent(raw).replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-80)
        const dir = path.join(server.config.root, 'public', '_media')
        fs.mkdirSync(dir, { recursive: true })
        // 以前这儿有一条「同名 + 大小一样就当同一个文件,直接复用旧的」的近路。
        // 它把「换了一版、恰好差不多大」的素材挡在门外:界面报成功,用的还是旧文件。
        // 省下的那点时间不值这个误判,老老实实每次都写。
        saveUpload(req, res, path.join(dir, safe), `/_media/${encodeURIComponent(safe)}`)
      })

      server.middlewares.use('/api/export-status', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(prog))
      })
      server.middlewares.use('/api/export', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        if (busy) {
          res.statusCode = 429
          res.end(JSON.stringify({ ok: false, error: '已有导出任务在进行中' }))
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          busy = true
          try {
            const job = JSON.parse(body || '{}')
            job.base = `http://localhost:${server.config.server.port ?? 5177}`
            const jobFile = path.join(os.tmpdir(), `overlay-export-${Date.now()}.json`)
            fs.writeFileSync(jobFile, JSON.stringify(job))

            const child = spawn('node', ['scripts/export-frames.mjs', jobFile], {
              cwd: server.config.root,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            prog = {
              running: true, stage: 'prep', frame: 0, total: 0,
              finalOnly: job.finalOnly === true,
            }
            let out = ''
            let err = ''
            // 看门狗:子进程 15 分钟没有任何输出就当它假死,强制停掉。不设的话 busy 永远是 true,
            // 之后每次点导出都是「已有导出任务在进行中」,只能重启服务。15 分钟留给最慢的静默
            // 阶段(长视频抽帧、ProRes 合成都不打进度);脚本内部另有 30 秒的单帧超时兜常见情况。
            const IDLE_MS = 15 * 60_000
            const giveUp = () => {
              err +=
                '\n【导出失败原因】导出 15 分钟没有任何进展,已强制停止。多半是渲染器假死了:' +
                '重新导出一次;还不行就重启 npm run dev。'
              // 先 SIGTERM:导出脚本收到后会杀掉成片合成的 ffmpeg、删掉它写了一半的 MP4,
              // 渲染没做完的话还要删掉 PNG 目录(长片子几万张,要点时间)再退出;
              // 直接 SIGKILL 的话那个 ffmpeg 会变成孤儿接着跑。30 秒还不走再强杀。
              // 管不到的情况:卡在 MOV/WebM 合成(同步调用,脚本收不到信号,强杀后那个 ffmpeg 会留下);
              // Windows 上 SIGTERM 等于直接结束进程,脚本来不及清理
              child.kill('SIGTERM')
              setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 30_000)
            }
            let idle = setTimeout(giveUp, IDLE_MS)
            const kick = () => {
              clearTimeout(idle)
              idle = setTimeout(giveUp, IDLE_MS)
            }
            child.stdout.on('data', (d) => {
              kick()
              out += d
              process.stdout.write(`[export] ${d}`)
              // 进度、阶段、「预计还需」都从输出里解析(规则和测试见 scripts/export-progress.mjs)
              applyExportOutput(prog, out)
            })
            child.stderr.on('data', (d) => {
              kick()
              err += d
            })
            child.on('close', (code) => {
              clearTimeout(idle)
              busy = false
              prog = { ...prog, running: false, stage: 'done', ok: code === 0 }
              fs.rmSync(jobFile, { force: true })
              res.setHeader('Content-Type', 'application/json')
              if (code === 0) {
                // 取脚本最后一行 JSON 作为结果
                const lines = out.trim().split('\n')
                res.end(lines[lines.length - 1])
              } else {
                res.statusCode = 500
                res.end(JSON.stringify({ ok: false, error: err.slice(-800) }))
              }
            })
          } catch (e) {
            busy = false
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(e) }))
          }
        })
      })
    },
  }
}

/** 录屏上传:POST /api/upload-demo?name=xxx.mp4(原始字节流)→ 存进 public/demo/,返回可用路径 */
function demoUpload(): Plugin {
  return {
    name: 'demo-upload',
    configureServer(server) {
      server.middlewares.use('/api/upload-demo', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        try {
          const q = new URL(req.url ?? '', 'http://x').searchParams
          // 只留文件名本体,防路径穿越;空格等字符统一成下划线
          const raw = decodeURIComponent(q.get('name') || 'demo.mp4')
          const name = path.basename(raw).replace(/[^\w.一-龥()-]/g, '_')
          const dir = path.join(server.config.root, 'public', 'demo')
          fs.mkdirSync(dir, { recursive: true })
          // 先写临时文件再改名:用户在文件选择器里选中 public/demo 里的同名文件时,
          // 直接写 dest 会一边读一边截断源文件(自毁);临时文件+rename 则安全覆盖
          saveUpload(req, res, path.join(dir, name), `/demo/${name}`)
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: String(e) }))
        }
      })
    },
  }
}

/** 学习闭环:POST /api/review-log → 把「AI 初选 vs 用户终选」存进 exports/review-logs/,供「学一下」用 */
function reviewLog(): Plugin {
  return {
    name: 'review-log',
    configureServer(server) {
      server.middlewares.use('/api/review-log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            JSON.parse(body) // 只校验是合法 JSON,原样落盘
            const dir = path.join(server.config.root, 'exports', 'review-logs')
            fs.mkdirSync(dir, { recursive: true })
            const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
            const dest = path.join(dir, `${stamp}-review-log.json`)
            fs.writeFileSync(dest, body)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, file: dest }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(e) }))
          }
        })
      })
    },
  }
}

/** 时间轴波形:GET /api/waveform?src=/_media/xxx.mp4 → { ok, rate, peaks }
 *
 *  在服务端用 ffmpeg 解出单声道 8kHz 音频,按每秒 PEAKS_PER_SEC 格取峰值,归一化到 0–255。
 *  不在浏览器里 decodeAudioData:那要把整段视频文件读进内存再整段解码,十几分钟的口播会吃掉几百 MB。
 *  没装 ffmpeg 就返回 ok:false,时间轴只是不画波形。
 *
 *  它会起 ffmpeg 进程,所以收得很紧:
 *   - 只读 public/_media/ 里的音视频文件(导入的口播视频都存在那儿);
 *   - 拒绝别的网站发来的请求:开着 Studio 时你逛的任何网页,都能用一个 <img src> 打到
 *     localhost:5177,浏览器会带上 Sec-Fetch-Site: cross-site,见到就拒;
 *   - 同一个文件同时只解一次(后来的请求等同一个结果),全局最多同时解 WAVE_MAX_JOBS 个;
 *   - 请求方都断开了就杀掉 ffmpeg,不白跑。
 */
const PEAKS_PER_SEC = 50
const WAVE_SAMPLE_RATE = 8000
const WAVE_MAX_JOBS = 2
const WAVE_EXT = /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|wav|aac)$/i
/**
 * 峰值归一化到 0–255,以「有声部分的第 99 百分位」为满格,而不是全片最大值。
 * 按最大值归一化时,一声拍手、一个爆破音就能把整段人声压成很矮的一条 ——
 * 停顿检测(低于满格的约 6% 算没声音)随之把轻声说话也当成停顿。超过满格的少数峰值截到 255。
 * 静音格(<1% 量程)不参与取百分位,否则片头片尾的长空白会把满格拉低。
 */
export function normalizePeaks(raw: number[]): number[] {
  const voiced = raw.filter((v) => v > 327).sort((a, b) => a - b)
  // 整段都没声音时按满量程算,别把底噪放大成满格
  const top = voiced.length ? voiced[Math.min(voiced.length - 1, Math.floor(voiced.length * 0.99))] : 32767
  return raw.map((v) => Math.min(255, Math.round((v / top) * 255)))
}

type WaveResult = { ok: true; rate: number; peaks: number[] } | { ok: false; error: string; detail?: string }

/** 起一个 ffmpeg 解峰值。kill() 中途停掉(结果当失败,不进缓存) */
function decodePeaks(file: string): { done: Promise<WaveResult>; kill: () => void } {
  const per = WAVE_SAMPLE_RATE / PEAKS_PER_SEC
  const raw: number[] = []
  let bucketMax = 0
  let inBucket = 0
  let carry: Buffer | null = null
  let err = ''
  const child = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(WAVE_SAMPLE_RATE), '-f', 's16le', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const done = new Promise<WaveResult>((resolve) => {
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
    child.stdout.on('data', (chunk: Buffer) => {
      // 16 位样本可能被切在两个数据块之间:上一块剩下的半个字节拼到这一块前面
      const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
      const n = buf.length - (buf.length % 2)
      carry = n < buf.length ? buf.subarray(n) : null
      for (let i = 0; i < n; i += 2) {
        const v = Math.abs(buf.readInt16LE(i))
        if (v > bucketMax) bucketMax = v
        if (++inBucket >= per) {
          raw.push(bucketMax)
          bucketMax = 0
          inBucket = 0
        }
      }
    })
    child.on('error', () => resolve({ ok: false, error: '本机没装 ffmpeg,时间轴不显示波形' }))
    child.on('close', (code) => {
      if (inBucket) raw.push(bucketMax)
      if (code !== 0 || !raw.length) {
        // 没音轨时 ffmpeg 只报一句「Invalid argument」,对用户没意义:说人话,原文放 detail
        return resolve({ ok: false, error: '读不到音轨(这段素材可能没有声音)', detail: err.trim().split('\n').pop() })
      }
      resolve({ ok: true, rate: PEAKS_PER_SEC, peaks: normalizePeaks(raw) })
    })
  })
  return { done, kill: () => child.kill('SIGKILL') }
}

/** 响度(给编辑台预览用):和成片同一套 ebur128 量法和增益算法(scripts/loudness.mjs) */
type LoudResult = { ok: true; lufs: number; gainDb: number; status: string | null } | { ok: false; error: string }
function measureLoud(file: string): { done: Promise<LoudResult>; kill: () => void } {
  const child = spawn('ffmpeg', ebur128Args(file), { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  const done = new Promise<LoudResult>((resolve) => {
    // 汇总在 stderr 最后几行,只留尾巴
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)))
    child.on('error', () => resolve({ ok: false, error: '本机没装 ffmpeg,预览不做响度统一' }))
    child.on('close', () => {
      const lufs = parseLoudness(err)
      if (lufs === null) return resolve({ ok: false, error: '读不到音轨(这段素材可能没有声音)' })
      resolve({ ok: true, lufs, gainDb: loudnessGain(lufs), status: loudnessStatus(lufs) })
    })
  })
  return { done, kill: () => child.kill('SIGKILL') }
}

/** 缓存键 = 文件路径 + 修改时间(换了一版同名素材会重算);每个接口最多留几条,够来回切素材用 */
const WAVE_CACHE_MAX = 8

/**
 * 「对 _media 里的一个文件跑一次 ffmpeg、把结果回给页面」这类接口的公共部分(波形、响度):
 *   - 只认 Studio 自己的页面(same-origin)和直接打开(none)。same-site 也拒:localhost 别的端口上
 *     跑的页面算 same-site。不带这个头的(curl 之类非浏览器)放行;
 *   - 只读 public/_media/ 里的音视频;
 *   - 同一个文件同时只跑一次(后来的请求等同一个结果),每个接口最多同时跑 WAVE_MAX_JOBS 个;
 *   - 请求方都走了就杀掉 ffmpeg;成功的结果按「路径 + 修改时间」缓存。
 */
function mediaJobRoute<R extends { ok: boolean }>(
  server: { config: { root: string }; middlewares: { use: (route: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void } },
  route: string,
  run: (file: string) => { done: Promise<R>; kill: () => void },
  busy: string,
) {
  const cache = new Map<string, R>()
  /** 正在跑的:users = 还在等结果的请求数 */
  const inflight = new Map<string, { done: Promise<R>; kill: () => void; users: number }>()
  server.middlewares.use(route, (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const reply = (code: number, body: object) => {
      if (res.writableEnded) return
      res.statusCode = code
      res.end(JSON.stringify(body))
    }
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none')
      return reply(403, { ok: false, error: '不接受其他网站的请求' })
    const src = new URL(req.url ?? '', 'http://x').searchParams.get('src') ?? ''
    const media = path.join(server.config.root, 'public', '_media')
    const file = resolvePublic(path.join(server.config.root, 'public'), src)
    if (!file || !isInside(media, file) || !WAVE_EXT.test(file))
      return reply(400, { ok: false, error: '只能读 public/_media/ 里的音视频' })
    if (!fs.existsSync(file)) return reply(404, { ok: false, error: '素材不存在' })

    const key = `${file}:${Math.floor(fs.statSync(file).mtimeMs)}`
    const hit = cache.get(key)
    if (hit) return reply(200, hit)

    let job = inflight.get(key)
    if (!job) {
      if (inflight.size >= WAVE_MAX_JOBS) return reply(429, { ok: false, error: busy })
      const d = run(file)
      const created = { ...d, users: 0 }
      job = created
      inflight.set(key, created)
      d.done.then((r) => {
        // 只删自己:被杀掉之后同一个文件可能已经起了新的一轮,别把新的那轮删了
        if (inflight.get(key) === created) inflight.delete(key)
        if (!r.ok) return
        cache.set(key, r)
        if (cache.size > WAVE_CACHE_MAX) cache.delete(cache.keys().next().value as string)
      })
    }
    const j = job
    j.users++
    let waiting = true
    // 请求方都走了(刷新、关页面、换了视频)就别让 ffmpeg 接着跑。
    // 杀掉时立刻从 inflight 摘掉:ffmpeg 退出前又来的同文件请求要起新的一轮,
    // 不能挂到这个注定失败的任务上
    res.on('close', () => {
      if (!waiting) return
      waiting = false
      if (--j.users === 0) {
        if (inflight.get(key) === j) inflight.delete(key)
        j.kill()
      }
    })
    j.done.then((r) => {
      if (!waiting) return
      waiting = false
      j.users--
      reply(200, r)
    })
  })
}

/** GET /api/waveform?src=…(时间轴波形)和 GET /api/loudness?src=…(预览里的响度统一) */
function waveform(): Plugin {
  return {
    name: 'waveform',
    configureServer(server) {
      mediaJobRoute(server, '/api/waveform', decodePeaks, '正在算别的波形,稍后再试')
      mediaJobRoute(server, '/api/loudness', measureLoud, '正在量别的素材,稍后再试')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), sfxFallback(), overlayExport(), demoUpload(), reviewLog(), waveform()],
  server: {
    port: 5177, // Overlay Studio 固定端口,避免和其他项目的 5173/5174 混淆
    // 端口被占时**报错退出**,不许自己顺延到 5178。
    // 顺延是个隐蔽的坑:localStorage 按 origin 隔离,5177 和 5178 是两套存档,
    // 编排会"看起来丢了";启动器又是写死 curl/open 5177 的,顺延后浏览器还会打不开。
    // 宁可起不来报一句"5177 被占了",也不要静悄悄换个门牌。
    strictPort: true,
    open: true, // 启动后自动打开浏览器
  },
})
