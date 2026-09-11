import 'dotenv/config'
import { chromium, type Browser, type Cookie, type Locator, type Page } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { DouyinCookie, SameSite } from './types/douyin-cookie'
import type { Yiyan } from './types/yiyan'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('zh-cn')

const DOUYIN_ACCOUNTS_KEY = 'DOUYIN_ACCOUNTS'
const DOUYIN_COOKIE_KEY = 'DOUYIN_COOKIE'
const DOUYIN_TARGET_NAMES_KEY = 'DOUYIN_TARGET_NAMES'
const DOUYIN_TARGET_GROUPS_KEY = 'DOUYIN_TARGET_GROUPS'
const YIYAN_INCLUDE_SOURCE_KEY = 'YIYAN_INCLUDE_SOURCE'
const SPARK_MESSAGE_TEMPLATE_KEY = 'SPARK_MESSAGE_TEMPLATE'
const FAILURE_SCREENSHOT_DIRECTORY = 'artifacts'

const CHAT_PAGE_READY_TIMEOUT = 30000
const CHAT_PAGE_IDLE_TIMEOUT = 10000
const SEARCH_RESULT_TIMEOUT = 5000
const SEARCH_RETRY_LIMIT = 3
const SEARCH_RETRY_INTERVAL = 2000
const SEARCH_INPUT_RESET_DELAY = 500
// 等待搜索结果里的「发消息 / 发私信」按钮出现。群聊条目没有这个按钮，
// 因此这个超时不能太长，否则每个群聊都要白等一轮才走点击条目的兜底逻辑。
const CONVERSATION_ACTION_TIMEOUT = 3000

// 发送前校验「右侧打开的会话是不是目标本人」：切换会话有延迟，不等标题变过来就输入会把消息发给上一个人。
const CONVERSATION_TITLE_SELECTOR = '.RightPanelHeadertitle'
const CONVERSATION_TITLE_TIMEOUT = 10000
const TITLE_POLL_INTERVAL = 300

const CHAT_EDITOR_SELECTOR =
  '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]'
const EDITOR_READY_TIMEOUT = 10000

// 发送后校验消息确实发出去了：发出去了抖音会清空输入框，回车被吞时会留下残留内容。
const SEND_VERIFY_TIMEOUT = 4000
const SEND_VERIFY_INTERVAL = 300
const SEND_ATTEMPT_LIMIT = 2

const MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const MESSAGE_TEMPLATE_PLACEHOLDERS = [
  'account',
  'friend',
  'yiyan',
  'from',
  'date',
  'time',
  'weekday',
] as const

type MessageTemplatePlaceholder = (typeof MESSAGE_TEMPLATE_PLACEHOLDERS)[number]

type ChatTargetKind = 'friend' | 'group'

interface ChatTarget {
  /** 会话名称：好友昵称/备注名，或群名称 */
  name: string
  /** 会话类型，决定日志文案、失败排查建议与失败截图文件名 */
  kind: ChatTargetKind
}

/** 单个目标的执行结果 */
type TargetOutcome = 'sent' | 'skipped' | 'failed'

interface TargetResult {
  target: ChatTarget
  outcome: TargetOutcome
  /** 成功时的目标会话名，失败或未命中时的具体原因 */
  detail: string
}

interface DouyinAccount {
  name: string
  cookies: Cookie[]
  /** 需要续火的好友会话名 */
  targetNames: string[]
  /** 需要发消息的群名称，未配置时为空数组 */
  groupNames: string[]
  messageTemplate: string | undefined
}

/**
 * 启动本机 Chrome 浏览器并携带 Cookie 访问抖音聊天页。
 */
async function main(): Promise<void> {
  const browserPath = resolveBrowserPath()
  const headless = resolveHeadless()
  const autoClose = resolveAutoClose()
  const includeYiyanSource = resolveYiyanIncludeSource()
  const globalMessageTemplate = resolveSparkMessageTemplate()
  const accounts = resolveDouyinAccounts(globalMessageTemplate)
  const yiyans = await resolveYiyans()
  const browser = await chromium.launch({
    headless,
    ...(browserPath ? { executablePath: browserPath } : {}),
  })
  const failures: Error[] = []

  try {
    for (const account of accounts) {
      try {
        await runDouyinAccount(browser, account, yiyans, includeYiyanSource, autoClose)
      } catch (error) {
        const accountError = toError(error)
        failures.push(
          new Error(`[${account.name}] ${accountError.message}`, { cause: accountError }),
        )
        console.error(`账号执行失败：${account.name}`, accountError)
      }
    }

    if (!autoClose) {
      const readline = createInterface({
        input,
        output,
      })

      await readline.question('所有账号已执行完成，按回车键关闭浏览器...')
      readline.close()
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} 个抖音账号执行失败`)
    }
  } finally {
    // 无论任务是否失败，都关闭浏览器以释放 Playwright 持有的进程句柄。
    await browser.close()
  }
}

/**
 * 使用独立浏览器上下文执行一个抖音账号，避免不同账号的 Cookie 相互污染。
 *
 * @param browser Playwright 浏览器实例。
 * @param account 当前执行的抖音账号配置。
 * @param yiyans 可供消息模板使用的一言列表。
 * @param includeYiyanSource 默认消息是否包含一言出处。
 * @param autoClose 执行结束后是否自动关闭浏览器上下文。
 * @returns 账号执行完成后的 Promise。
 */
async function runDouyinAccount(
  browser: Browser,
  account: DouyinAccount,
  yiyans: Yiyan[],
  includeYiyanSource: boolean,
  autoClose: boolean,
): Promise<void> {
  const context = await browser.newContext()
  let page: Page | undefined

  try {
    console.log(`开始执行账号：${account.name}`)
    await context.addCookies(account.cookies)

    page = await context.newPage()
    await page.goto('https://www.douyin.com/chat', {
      waitUntil: 'domcontentloaded',
    })

    const searchInput = page.locator('input.semi-input[placeholder="搜索"]').first()
    const searchVisible = await searchInput
      .waitFor({ state: 'visible', timeout: CHAT_PAGE_READY_TIMEOUT })
      .then(() => true)
      .catch(() => false)

    if (!searchVisible) {
      throw new Error('聊天页搜索框未出现，Cookie 可能已经失效')
    }

    await waitForChatListReady(page, account.name)

    const needsYiyan =
      account.messageTemplate === undefined ||
      /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)

    // 逐个目标独立执行：某一个目标出错不会中断后面的目标，结果统一收集起来最后汇总。
    const results: TargetResult[] = []

    for (const target of resolveChatTargets(account)) {
      try {
        results.push(
          await deliverToTarget(
            page,
            searchInput,
            account,
            target,
            yiyans,
            needsYiyan,
            includeYiyanSource,
          ),
        )
      } catch (error) {
        // 兜底：即使投递过程抛出未预料的异常，也只记为这个目标失败，继续处理下一个。
        results.push({ target, outcome: 'failed', detail: toError(error).message })
      }
    }

    logTargetSummary(account.name, results)

    await page.waitForTimeout(2000)

    // 有任何一个目标没成功，就让这次运行失败，确保失败邮件能把问题送到人眼前。
    if (results.some((result) => result.outcome !== 'sent')) {
      throw new Error(describeTargetResults(results))
    }

    console.log(`账号执行完成：${account.name}`)
  } catch (error) {
    await captureFailureScreenshot(page, account.name)
    throw error
  } finally {
    if (autoClose) {
      await context.close()
    }
  }
}

/**
 * 把账号配置里的目标合并成统一列表：带身份信息的目标在前，兼容配置的好友、群聊在后。
 *
 * 三种来源只是配置写法不同，合并后共用同一套搜索、身份确认与发送逻辑。
 *
 * @param account 当前执行的抖音账号配置。
 * @returns 按「targets → 好友 → 群聊」顺序排列的目标列表。
 */
function resolveChatTargets(account: DouyinAccount): ChatTarget[] {
  return [
    ...account.targetNames.map((name) => ({ name, kind: 'friend' as const })),
    ...account.groupNames.map((name) => ({ name, kind: 'group' as const })),
  ]
}

/**
 * 打开搜索命中的会话。
 *
 * 好友条目里带「发消息 / 发私信」按钮，点击按钮才能进入私信；
 * 群聊条目没有这个按钮，直接点条目本身即可进入群会话。
 * 两种形态都存在，所以这里做两级兜底：先找按钮，找不到就点条目。
 *
 * @param searchResult 搜索命中的结果条目。
 * @param targetLabel 用于日志的中文类型名（好友 / 群聊）。
 * @returns 打开会话后的 Promise。
 */
async function openConversation(searchResult: Locator, targetLabel: string): Promise<void> {
  const actionButton = searchResult.getByText(/^(发消息|发私信)$/).first()
  const hasActionButton = await actionButton
    .waitFor({ state: 'visible', timeout: CONVERSATION_ACTION_TIMEOUT })
    .then(() => true)
    .catch(() => false)

  if (hasActionButton) {
    await actionButton.click({ timeout: 5000 })
    return
  }

  console.log(`未出现「发消息」按钮，直接点击条目进入${targetLabel}会话`)
  await searchResult.click({ timeout: 5000 })
}

/**
 * 完成一个目标的完整投递：搜索 → 打开会话 → 校验会话标题 → 发送 → 校验已发出。
 *
 * 每一步都做校验：
 * 1. 搜索未命中 → 记为 skipped（不抛错，避免连累其它目标）；
 * 2. 打开后的会话标题与目标不一致 → 记为 failed 并中止，宁可不发也不发错人；
 * 3. 发送后输入框仍有残留 → 记为 failed，避免把「假成功」当成成功。
 *
 * @returns 该目标的执行结果；正常路径不抛异常，异常由调用方兜底记录。
 */
async function deliverToTarget(
  page: Page,
  searchInput: Locator,
  account: DouyinAccount,
  target: ChatTarget,
  yiyans: Yiyan[],
  needsYiyan: boolean,
  includeYiyanSource: boolean,
): Promise<TargetResult> {
  const targetLabel = target.kind === 'group' ? '群聊' : '好友'
  const logPrefix = `[${account.name}]`

  console.log(`${logPrefix} 开始处理${targetLabel}：${target.name}`)

  const searchResult = await searchConversation(page, searchInput, account.name, target.name)

  if (!searchResult) {
    await captureFailureScreenshot(page, `${account.name}-${target.kind}-${target.name}-search`)
    console.log(`${logPrefix} 搜索结果未命中：${target.name}`)
    return { target, outcome: 'skipped', detail: '搜索结果里找不到这个会话名' }
  }

  await openConversation(searchResult, targetLabel)

  const conversationTitle = await waitForConversationTitle(page, target.name)

  if (!conversationTitle) {
    const actualTitle = await readConversationTitle(page)
    await captureFailureScreenshot(page, `${account.name}-${target.kind}-${target.name}-title`)
    const detail =
      `会话标题与目标不一致，已中止以免发错人` +
      `（期望包含「${target.name}」，实际打开的是「${actualTitle || '读不到标题'}」）`
    console.log(`${logPrefix} ${detail}`)
    return { target, outcome: 'failed', detail }
  }

  console.log(`${logPrefix} 已确认会话：${conversationTitle}`)

  const editorInput = page.locator(CHAT_EDITOR_SELECTOR).first()
  await editorInput.waitFor({ state: 'visible', timeout: EDITOR_READY_TIMEOUT })

  const message = buildMessage(account, target.name, yiyans, needsYiyan, includeYiyanSource)

  await sendMessageWithVerification(page, editorInput, message, conversationTitle, account.name)

  console.log(`${logPrefix} 已发送消息：${target.name}`)
  await page.waitForTimeout(1000)

  return { target, outcome: 'sent', detail: `已发送到「${conversationTitle}」` }
}

/**
 * 按配置的消息模板或默认一言格式生成要发送的文本。
 */
function buildMessage(
  account: DouyinAccount,
  targetName: string,
  yiyans: Yiyan[],
  needsYiyan: boolean,
  includeYiyanSource: boolean,
): string {
  if (account.messageTemplate !== undefined) {
    return renderMessageTemplate(
      account.messageTemplate,
      account.name,
      targetName,
      needsYiyan ? pickRandomYiyan(yiyans) : undefined,
    )
  }

  const yiyan = pickRandomYiyan(yiyans)
  return includeYiyanSource ? `${yiyan.hitokoto}\n——「${yiyan.from}」` : yiyan.hitokoto
}

/**
 * 读取当前右侧会话的标题。
 */
async function readConversationTitle(page: Page): Promise<string> {
  return (
    await page
      .locator(CONVERSATION_TITLE_SELECTOR)
      .first()
      .innerText()
      .catch(() => '')
  ).trim()
}

/**
 * 等待右侧会话标题变成目标会话。
 *
 * 搜索结果出现不等于会话已经切换完成：切换有延迟，此时直接输入会把消息发到上一个会话的人那里。
 * 因此以标题为判据，标题里包含目标名才算就绪（群聊标题带人数后缀，如「群名(5)」，用包含判断即可）。
 *
 * @returns 匹配到的标题；超时仍未匹配则返回 undefined，由调用方中止该目标。
 */
async function waitForConversationTitle(
  page: Page,
  targetName: string,
): Promise<string | undefined> {
  const deadline = Date.now() + CONVERSATION_TITLE_TIMEOUT

  while (Date.now() < deadline) {
    const title = await readConversationTitle(page)

    if (title.includes(targetName)) {
      return title
    }

    await delay(TITLE_POLL_INTERVAL)
  }

  return undefined
}

/**
 * 发送消息并校验真的发出去了。
 *
 * 判据是「输入框是否被清空」：发出去了抖音会清空编辑器，回车被吞或被打断时文字会留在里面。
 * 未清空就重试，仍失败则抛错，由调用方记为失败——避免把假成功当成成功。
 */
async function sendMessageWithVerification(
  page: Page,
  editorInput: Locator,
  message: string,
  conversationTitle: string,
  accountName: string,
): Promise<void> {
  for (let attempt = 1; attempt <= SEND_ATTEMPT_LIMIT; attempt += 1) {
    await editorInput.click()
    await page.keyboard.insertText(message)
    await page.keyboard.press('Enter')

    if (await waitForEditorCleared(editorInput)) {
      return
    }

    const leftover = (await editorInput.innerText().catch(() => '')).trim()
    console.log(
      `[${accountName}] 在「${conversationTitle}」发送后输入框仍有残留，疑似假成功，准备重试（第 ${attempt} 次）：${leftover.slice(0, 30)}`,
    )
    await page.waitForTimeout(1500)
  }

  throw new Error(
    `发送后输入框仍有内容残留，判定为假成功（消息未真正发出）：${message.trim().slice(0, 30)}`,
  )
}

/**
 * 等待输入框被清空。
 */
async function waitForEditorCleared(editorInput: Locator): Promise<boolean> {
  const deadline = Date.now() + SEND_VERIFY_TIMEOUT

  while (Date.now() < deadline) {
    const text = await editorInput.innerText().catch(() => null)

    if (text !== null && text.trim() === '') {
      return true
    }

    await delay(SEND_VERIFY_INTERVAL)
  }

  return false
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/**
 * 把每个目标的执行结果打到日志里，一眼能看出谁成功、谁没成功。
 */
function logTargetSummary(accountName: string, results: TargetResult[]): void {
  const sent = results.filter((result) => result.outcome === 'sent')
  const skipped = results.filter((result) => result.outcome === 'skipped')
  const failed = results.filter((result) => result.outcome === 'failed')

  console.log(
    `[${accountName}] 续火汇总：成功 ${sent.length}、未命中 ${skipped.length}、失败 ${failed.length}（共 ${results.length} 个目标）`,
  )

  for (const result of results) {
    const label =
      result.outcome === 'sent'
        ? '✅ 已发送'
        : result.outcome === 'skipped'
          ? '⏭️ 未命中'
          : '❌ 失败'
    console.log(`[${accountName}]   ${label}｜${result.target.name}：${result.detail}`)
  }
}

/**
 * 汇总各目标结果，供抛出异常（触发失败邮件）时使用，并按好友、群聊分别给出排查建议。
 */
function describeTargetResults(results: TargetResult[]): string {
  const sent = results.filter((result) => result.outcome === 'sent')
  const skipped = results.filter((result) => result.outcome === 'skipped')
  const failed = results.filter((result) => result.outcome === 'failed')
  const sections = [
    `本次续火未全部成功：成功 ${sent.length}、未命中 ${skipped.length}、失败 ${failed.length}（共 ${results.length} 个目标）`,
  ]

  if (sent.length > 0) {
    sections.push(`已成功发送：${sent.map((result) => result.target.name).join('、')}`)
  }

  for (const result of [...skipped, ...failed]) {
    const label = result.outcome === 'skipped' ? '未命中' : '失败'
    sections.push(`${label}｜${result.target.name}：${result.detail}`)
  }

  const unsuccessful = [...skipped, ...failed]

  if (unsuccessful.some((result) => result.target.kind === 'friend')) {
    sections.push(
      '好友未命中或失败时，最常见的原因是改了昵称：建议在抖音中为好友设置备注名，' +
        '并把备注名填入账号的 targetNames，这样好友再改昵称也不会影响续火。',
    )
  }

  if (unsuccessful.some((result) => result.target.kind === 'group')) {
    sections.push(
      '群聊未命中或失败时，请确认群名与抖音内显示的名称完全一致（标点、空格、表情都要一致），' +
        '并确认你仍在群内、群没有被解散。',
    )
  }

  return sections.join('\n')
}

/**
 * 等待会话列表真正渲染出数据再开始搜索。
 *
 * 搜索框会先于会话列表渲染，若此时就输入关键词，抖音的搜索索引尚未就绪，
 * 结果面板会一直为空，导致好友被误判成「改名了」。
 *
 * @param page 当前账号的聊天页。
 * @param accountName 账号名称，仅用于日志。
 * @returns 等待结束后的 Promise，超时也不抛错，交给后续搜索重试兜底。
 */
async function waitForChatListReady(page: Page, accountName: string): Promise<void> {
  const conversationListReady = await page
    .locator('[class*="conversation"], [class*="Conversation"]')
    .first()
    .waitFor({ state: 'visible', timeout: CHAT_PAGE_READY_TIMEOUT })
    .then(() => true)
    .catch(() => false)

  if (!conversationListReady) {
    console.log(`[${accountName}] 会话列表未在预期时间内出现，将依赖搜索重试兜底`)
  }

  // 会话列表的头像与最近消息还会继续拉取，等网络安静下来搜索命中率更高。
  await page.waitForLoadState('networkidle', { timeout: CHAT_PAGE_IDLE_TIMEOUT }).catch(() => {})
}

/**
 * 带重试地搜索会话，避免把「数据还没加载好」误判成「好友改了昵称」。
 *
 * 每一轮都重新清空输入框并等待旧结果消失，防止上一个好友的残留结果被当成命中。
 *
 * @param page 当前账号的聊天页。
 * @param searchInput 聊天页左侧的搜索输入框。
 * @param accountName 账号名称，仅用于日志。
 * @param targetName 需要搜索的好友昵称或备注名。
 * @returns 命中的搜索结果项，全部重试都没命中时返回 undefined。
 */
async function searchConversation(
  page: Page,
  searchInput: Locator,
  accountName: string,
  targetName: string,
): Promise<Locator | undefined> {
  const searchResult = page
    .locator('.SearchPanelitembox')
    .filter({
      has: page.getByText(targetName, { exact: true }),
    })
    .first()

  for (let attempt = 1; attempt <= SEARCH_RETRY_LIMIT; attempt += 1) {
    await searchInput.fill('')
    // 等旧的结果面板收起，否则会读到上一个好友残留的列表项。
    await page
      .locator('.SearchPanelitembox')
      .first()
      .waitFor({ state: 'hidden', timeout: SEARCH_RESULT_TIMEOUT })
      .catch(() => {})
    await page.waitForTimeout(SEARCH_INPUT_RESET_DELAY)
    await searchInput.fill(targetName)

    const searchResultVisible = await searchResult
      .waitFor({ state: 'visible', timeout: SEARCH_RESULT_TIMEOUT })
      .then(() => true)
      .catch(() => false)

    if (searchResultVisible) {
      return searchResult
    }

    if (attempt < SEARCH_RETRY_LIMIT) {
      console.log(
        `[${accountName}] 第 ${attempt} 次搜索未命中，${SEARCH_RETRY_INTERVAL} 毫秒后重试：${targetName}`,
      )
      await page.waitForTimeout(SEARCH_RETRY_INTERVAL)
    }
  }

  return undefined
}

/**
 * 在页面仍可访问时保存失败现场，且不让截图错误覆盖原始任务异常。
 */
async function captureFailureScreenshot(
  page: Page | undefined,
  accountName: string,
): Promise<void> {
  if (!page || page.isClosed()) {
    return
  }

  try {
    await mkdir(FAILURE_SCREENSHOT_DIRECTORY, { recursive: true })
    const screenshotPath = `${FAILURE_SCREENSHOT_DIRECTORY}/failure-screenshot-${toSafeFileName(accountName)}.png`
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    })
    console.log(`已保存失败截图：${screenshotPath}`)
  } catch (error) {
    console.error('保存失败截图失败:', error)
  }
}

function toSafeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 解析 Playwright 可选的浏览器启动路径。
 */
function resolveBrowserPath(): string | undefined {
  const browserPathFromEnv = process.env.PLAYWRIGHT_BROWSER_PATH?.trim()

  if (browserPathFromEnv) {
    return browserPathFromEnv
  }

  return undefined
}

/**
 * 解析 Playwright 是否使用无头模式。
 */
function resolveHeadless(): boolean {
  const headless = process.env.PLAYWRIGHT_HEADLESS?.trim().toLowerCase()

  if (!headless) {
    return true
  }

  if (headless === 'true') {
    return true
  }

  if (headless === 'false') {
    return false
  }

  throw new Error('PLAYWRIGHT_HEADLESS 只能配置为 true 或 false')
}

/**
 * 解析脚本结束后是否自动关闭浏览器。
 */
function resolveAutoClose(): boolean {
  const autoClose = process.env.AUTO_CLOSE?.trim().toLowerCase()

  if (!autoClose) {
    return true
  }

  if (autoClose === 'true') {
    return true
  }

  if (autoClose === 'false') {
    return false
  }

  throw new Error('AUTO_CLOSE 只能配置为 true 或 false')
}

/**
 * 解析发送一言时是否携带出处。
 */
function resolveYiyanIncludeSource(): boolean {
  const includeSource = process.env[YIYAN_INCLUDE_SOURCE_KEY]?.trim().toLowerCase()

  if (!includeSource || includeSource === 'true') {
    return true
  }

  if (includeSource === 'false') {
    return false
  }

  throw new Error(`${YIYAN_INCLUDE_SOURCE_KEY} 只能配置为 true 或 false`)
}

/**
 * 解析自定义火花消息模板，未配置时返回 undefined 以沿用默认的一言格式。
 */
function resolveSparkMessageTemplate(): string | undefined {
  const template = process.env[SPARK_MESSAGE_TEMPLATE_KEY]?.trim()

  if (!template) {
    return undefined
  }

  return normalizeMessageTemplate(template, SPARK_MESSAGE_TEMPLATE_KEY)
}

/**
 * 校验并标准化消息模板。
 */
function normalizeMessageTemplate(template: string, sourceName: string): string {
  // 启动时就校验占位符，避免把写错的 {{xxx}} 原样发给好友。
  const unknownPlaceholders = [
    ...new Set(
      [...template.matchAll(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN)]
        .map((match) => match[1])
        .filter(
          (name) => !MESSAGE_TEMPLATE_PLACEHOLDERS.includes(name as MessageTemplatePlaceholder),
        ),
    ),
  ]

  if (unknownPlaceholders.length > 0) {
    throw new Error(
      `${sourceName} 中存在未识别的占位符：${unknownPlaceholders
        .map((name) => `{{${name}}}`)
        .join(
          '、',
        )}。支持的占位符：${MESSAGE_TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(' ')}`,
    )
  }

  // .env 中难以书写多行值，因此支持用字面 \n 表示换行。
  return template.replace(/\\n/g, '\n')
}

/**
 * 将消息模板渲染为实际发送的文本。
 */
function renderMessageTemplate(
  template: string,
  account: string,
  friend: string,
  yiyan: Yiyan | undefined,
): string {
  // 定时任务跑在 UTC 时区的 runner 上，日期占位符统一按上海时区计算。
  const now = dayjs().tz('Asia/Shanghai')
  const placeholderValues: Record<MessageTemplatePlaceholder, string> = {
    account,
    friend,
    yiyan: yiyan?.hitokoto ?? '',
    from: yiyan?.from ?? '',
    date: now.format('YYYY-MM-DD'),
    time: now.format('HH:mm'),
    weekday: now.format('dddd'),
  }

  return template.replace(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN, (_match, name: string) => {
    return placeholderValues[name as MessageTemplatePlaceholder] ?? ''
  })
}

/**
 * 解析多账号配置。未配置新变量时，回退到旧的单账号变量。
 */
function resolveDouyinAccounts(globalMessageTemplate: string | undefined): DouyinAccount[] {
  const accountsText = process.env[DOUYIN_ACCOUNTS_KEY]?.trim()

  if (!accountsText) {
    return [
      assertAccountHasTargets({
        name: '默认账号',
        cookies: resolveLegacyDouyinCookies(),
        targetNames: resolveLegacyDouyinTargetNames(),
        groupNames: resolveLegacyDouyinTargetGroups(),
        messageTemplate: globalMessageTemplate,
      }),
    ]
  }

  const accountsValue = parseJson(accountsText, DOUYIN_ACCOUNTS_KEY)

  if (!Array.isArray(accountsValue) || accountsValue.length === 0) {
    throw new Error(`${DOUYIN_ACCOUNTS_KEY} 必须是非空账号数组 JSON`)
  }

  const accountNames = new Set<string>()

  return accountsValue.map((value, index) => {
    const sourceName = `${DOUYIN_ACCOUNTS_KEY}[${index}]`

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${sourceName} 必须是账号对象`)
    }

    const accountValue = value as Record<string, unknown>
    const name = resolveAccountName(accountValue.name, sourceName)

    if (accountNames.has(name)) {
      throw new Error(`${DOUYIN_ACCOUNTS_KEY} 中存在重复账号名称：${name}`)
    }
    accountNames.add(name)

    return assertAccountHasTargets({
      name,
      cookies: resolveCookieArray(accountValue.cookie, `${sourceName}.cookie`),
      targetNames: resolveOptionalTargetNames(
        accountValue.targetNames,
        `${sourceName}.targetNames`,
      ),
      groupNames: resolveOptionalTargetNames(accountValue.groupNames, `${sourceName}.groupNames`),
      messageTemplate: resolveAccountMessageTemplate(
        accountValue.messageTemplate,
        `${sourceName}.messageTemplate`,
        globalMessageTemplate,
      ),
    })
  })
}

function resolveAccountName(value: unknown, sourceName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${sourceName}.name 必须是非空字符串`)
  }

  return value.trim()
}

function resolveAccountMessageTemplate(
  value: unknown,
  sourceName: string,
  globalMessageTemplate: string | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    return globalMessageTemplate
  }

  if (typeof value !== 'string') {
    throw new Error(`${sourceName} 必须是字符串`)
  }

  const template = value.trim()
  return template ? normalizeMessageTemplate(template, sourceName) : globalMessageTemplate
}

/**
 * 解析旧版单账号 Cookie 配置。
 */
function resolveLegacyDouyinCookies(): Cookie[] {
  const douyinCookieText = process.env[DOUYIN_COOKIE_KEY]?.trim()

  if (!douyinCookieText) {
    throw new Error(
      `请设置 ${DOUYIN_ACCOUNTS_KEY}，或继续使用旧版 ${DOUYIN_COOKIE_KEY} 和 ${DOUYIN_TARGET_NAMES_KEY}`,
    )
  }

  return resolveCookieArray(parseJson(douyinCookieText, DOUYIN_COOKIE_KEY), DOUYIN_COOKIE_KEY)
}

/**
 * 解析单账号配置里的好友会话名，未配置或配成空数组都表示不发好友。
 */
function resolveLegacyDouyinTargetNames(): string[] {
  return resolveEnvTargetNames(DOUYIN_TARGET_NAMES_KEY)
}

/**
 * 解析单账号配置里的群名称，未配置或配成空数组都表示不发群消息。
 */
function resolveLegacyDouyinTargetGroups(): string[] {
  return resolveEnvTargetNames(DOUYIN_TARGET_GROUPS_KEY)
}

/**
 * 从环境变量读取一组会话名称。
 *
 * 允许「留空」与「显式空数组」两种写法，这样只发群聊、不发好友的配置也能成立；
 * 但类型写错（例如把数组写成字符串）仍然立刻报错，避免静默漏发。
 */
function resolveEnvTargetNames(key: string): string[] {
  const text = process.env[key]?.trim()

  if (!text) {
    return []
  }

  return resolveOptionalTargetNames(parseJson(text, key), key)
}

/**
 * 解析可选的会话名称数组：未配置或配置为空数组都视为「这类目标不发」。
 *
 * 与 resolveTargetNameArray 的区别是不强制非空，这样只发群聊、不发好友的配置也能成立；
 * 但类型写错（例如把数组写成字符串）仍然立刻报错，避免静默漏发。
 */
function resolveOptionalTargetNames(value: unknown, sourceName: string): string[] {
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new Error(`${sourceName} 必须是字符串数组`)
  }

  if (value.length === 0) {
    return []
  }

  return resolveTargetNameArray(value, sourceName)
}

/**
 * 校验账号至少配置了一个续火对象，好友与群聊全空时直接报错提示怎么配。
 */
function assertAccountHasTargets(account: DouyinAccount): DouyinAccount {
  if (account.targetNames.length === 0 && account.groupNames.length === 0) {
    throw new Error(
      `账号「${account.name}」没有配置任何续火对象，` +
        `请用 ${DOUYIN_TARGET_NAMES_KEY} 配置好友会话名，或用 ${DOUYIN_TARGET_GROUPS_KEY} 配置群名称`,
    )
  }

  return account
}

function resolveCookieArray(value: unknown, sourceName: string): Cookie[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${sourceName} 必须是非空 Cookie 数组`)
  }

  return (value as DouyinCookie[]).map(toPlaywrightCookie)
}

function resolveTargetNameArray(value: unknown, sourceName: string): string[] {
  const targetNames = value as unknown[]

  if (
    !Array.isArray(targetNames) ||
    targetNames.length === 0 ||
    targetNames.some((targetName) => typeof targetName !== 'string' || !targetName.trim())
  ) {
    throw new Error(`${sourceName} 必须是非空字符串数组`)
  }

  return targetNames.map((targetName) => (targetName as string).trim())
}

function parseJson(value: string, sourceName: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`${sourceName} 不是有效的 JSON`, { cause: error })
  }
}

/**
 * 解析一言数据列表。
 */
async function resolveYiyans(): Promise<Yiyan[]> {
  const yiyanText = await readFile('assets/yiyan.json', 'utf8')
  const yiyans = JSON.parse(yiyanText) as Yiyan[]

  if (!Array.isArray(yiyans) || yiyans.length === 0) {
    throw new Error('assets/yiyan.json 必须是非空数组')
  }

  return yiyans
}

/**
 * 从一言数据中随机挑选一条。
 */
function pickRandomYiyan(yiyans: Yiyan[]): Yiyan {
  return yiyans[Math.floor(Math.random() * yiyans.length)]
}

/**
 * 将抖音 Cookie 数据转换为 Playwright Cookie 数据。
 */
function toPlaywrightCookie(cookie: DouyinCookie): Cookie {
  const playwrightCookie: Cookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: toPlaywrightSameSite(cookie.sameSite),
  }

  return playwrightCookie
}

/**
 * 将抖音 Cookie 的 SameSite 值转换为 Playwright Cookie 值。
 */
function toPlaywrightSameSite(sameSite: SameSite | null): Cookie['sameSite'] {
  if (sameSite === 'no_restriction') {
    return 'None'
  }

  return 'Lax'
}

main().catch((error: unknown) => {
  console.error('启动 Chrome 访问抖音聊天页失败:', error)
  process.exitCode = 1
})
