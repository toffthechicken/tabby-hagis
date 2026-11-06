/**
 * hagis 문서 뷰어 — 웹 패널 안에서 열리는 페이지 (HWP·Word·Excel·PowerPoint·PDF·텍스트·그림)
 *
 * 이 페이지는 viewer.service 의 로컬 서버(127.0.0.1, 무작위 토큰 주소)에서 열리고, 같은 서버가 사용자가 고른 파일을 준다.
 * 웹 패널과 같은 샌드박스(Node.js 권한 없음)에서 돌고, 서버가 붙이는 CSP 때문에 바깥으로 요청을 보낼 수 없다 —
 * 문서 안에 들어 있는 외부 그림·링크가 있어도 열 때 어디에도 접속하지 않는다.
 *
 * 쓰는 오픈소스: rhwp(HWP/HWPX, MIT) · docx-preview(DOCX, Apache-2.0) · SheetJS(XLSX 등, Apache-2.0) · pptx-preview(PPTX, ISC)
 * PDF 는 Chromium 내장 뷰어를 쓴다.
 *
 * 확대·축소: 패널의 −/+ 버튼(window.__hagisZoom)과 Ctrl+휠·Ctrl+(+/−/0) 으로 이 페이지가 직접 배율을 바꾼다.
 * Chromium 의 페이지 배율은 쓰지 않는다 — 문서를 창 폭에 맞춰 그리기 때문에, 배율을 올려도 창 폭이 줄어든 만큼 다시 맞춰져 커지지 않는다.
 */
import * as XLSX from 'xlsx'
import { renderAsync } from 'docx-preview'
import { init as initPptx } from 'pptx-preview'

const KINDS: Record<string, string[]> = {
    pdf: ['pdf'],
    hwp: ['hwp', 'hwpx'],
    docx: ['docx', 'docm', 'dotx'],
    sheet: ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'csv', 'tsv'],
    pptx: ['pptx'],
    text: ['txt', 'log', 'md', 'markdown', 'json', 'xml', 'cfg', 'conf', 'ini', 'yml', 'yaml'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'],
}

const MAX_ROWS = 10000
const MAX_COLS = 200
const MAX_TEXT = 5 * 1024 * 1024

const statusEl = document.getElementById('status') as HTMLElement
const app = document.getElementById('app') as HTMLElement

const params = new URLSearchParams(location.search)
const id = params.get('id') ?? ''
const fullPath = params.get('p') ?? ''
const name = fullPath.split(/[\\/]/).pop() || 'document'
const ext = (name.split('.').pop() ?? '').toLowerCase()
/** 서버가 붙인 "/<토큰>" */
const root = location.pathname.replace(/\/app\/viewer\.html$/, '')
const fileUrl = `${root}/f/${encodeURIComponent(id)}/${encodeURIComponent(name)}`

document.title = name

// ---------------------------------------------------------------- 배율

const MIN_SCALE = 0.3
const MAX_SCALE = 4
let scale = 1
const scaleHandlers: ((factor: number) => void)[] = []

function setScale (factor: number): void {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(factor * 100) / 100))
    for (const handler of scaleHandlers) {
        handler(scale)
    }
}

/** 종류별 보기가 배율이 바뀔 때 부를 함수를 등록한다 (등록하면서 현재 배율을 한 번 적용) */
function onScale (handler: (factor: number) => void): void {
    scaleHandlers.push(handler)
    handler(scale)
}

// 패널의 확대·축소 버튼이 부른다 (hagis 가 페이지가 열리면 현재 배율을 넘겨 준다)
;(window as any).__hagisZoom = (factor: number): void => setScale(Number(factor) || 1)
;(window as any).__hagisScale = (): number => scale
window.addEventListener('wheel', event => {
    if (event.ctrlKey) {
        event.preventDefault()
        setScale(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1))
    }
}, { passive: false })
window.addEventListener('keydown', event => {
    if (!event.ctrlKey) {
        return
    }
    if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        setScale(scale * 1.1)
    } else if (event.key === '-') {
        event.preventDefault()
        setScale(scale / 1.1)
    } else if (event.key === '0') {
        event.preventDefault()
        setScale(1)
    }
})

function setStatus (message: string, error = false): void {
    statusEl.textContent = message
    statusEl.className = error ? 'error' : ''
}

/** 화면 폭 (배율을 쓰지 않으므로 창 크기 그대로) */
function availableWidth (): number {
    return Math.max(240, document.documentElement.clientWidth - 24)
}

async function fetchBuffer (): Promise<ArrayBuffer> {
    const response = await fetch(fileUrl, { cache: 'no-store' })
    if (!response.ok) {
        throw new Error(`파일을 불러오지 못했습니다 (HTTP ${response.status}) — 파일이 옮겨졌거나 hagis 를 다시 시작한 뒤 오래된 주소입니다`)
    }
    return response.arrayBuffer()
}

/** 한글 텍스트 파일은 UTF-8 이 아닌 경우(EUC-KR/CP949)가 많다 */
function decodeText (buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer.byteLength > MAX_TEXT ? buffer.slice(0, MAX_TEXT) : buffer)
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
        return new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes)
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return new TextDecoder('euc-kr').decode(bytes)
    }
}

/** CSS zoom 은 레이아웃 크기까지 바꾸므로 가로·세로 스크롤이 자연스럽게 따라온다 */
function zoomOf (element: HTMLElement, factor: number): void {
    ;(element.style as any).zoom = String(factor)
}

// ---------------------------------------------------------------- 종류별 보기

function showPdf (): void {
    const frame = document.createElement('iframe')
    frame.className = 'full'
    frame.src = fileUrl
    frame.title = name
    app.appendChild(frame)
    // 쪽 안은 Chromium PDF 뷰어가 그린다. 이 뷰어는 바깥에서 배율을 바꾸는 방법이 없어(키 입력·주소 조각 변경 모두 무시됨),
    // 배율이 바뀌면 PDF 열기 매개변수(#zoom=배율%)를 붙여 다시 연다 — 처음 모습(배율 1)은 건드리지 않고, 이후엔 쪽 폭을 기준(A4 약 794px)으로 곱한다.
    // 다시 열면 첫 쪽으로 돌아가므로, 쪽을 옮겨 가며 볼 때는 뷰어 위쪽의 확대 메뉴(−/+)도 그대로 쓸 수 있다.
    let changed = false
    let timer: any = null
    onScale(factor => {
        if (factor === 1 && !changed) {
            return
        }
        changed = true
        clearTimeout(timer)
        timer = setTimeout(() => {
            const percent = Math.round((availableWidth() / 794) * factor * 100)
            frame.src = `${fileUrl}?z=${Math.round(factor * 100)}#pagemode=none&zoom=${Math.max(10, Math.min(500, percent))}`
        }, 250)
    })
}

/** SVG 는 폭에 맞춰 늘고 줄 수 있게 viewBox 를 보장한다 (쪽 높이/폭 비율을 돌려준다) */
function prepareSvg (holder: HTMLElement): number {
    const svg = holder.querySelector('svg')
    if (!svg) {
        return 0
    }
    let box = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
    if (box.length !== 4 || box.some(n => !isFinite(n))) {
        const w = parseFloat(svg.getAttribute('width') ?? '')
        const h = parseFloat(svg.getAttribute('height') ?? '')
        if (!(w > 0 && h > 0)) {
            return 0
        }
        box = [0, 0, w, h]
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    }
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    return box[3] / box[2]
}

async function showHwp (buffer: ArrayBuffer): Promise<void> {
    const rhwp: any = await import('@rhwp/core')
    const canvas = document.createElement('canvas').getContext('2d')!
    ;(globalThis as any).measureTextWidth = (font: string, text: string): number => {
        canvas.font = font
        return canvas.measureText(text).width
    }
    await rhwp.default({ module_or_path: `${root}/app/rhwp_bg.wasm` })
    const doc = new rhwp.HwpDocument(new Uint8Array(buffer))
    const count: number = doc.pageCount()
    const pages = document.createElement('div')
    pages.className = 'hv-pages'
    app.appendChild(pages)
    // 한 쪽의 기본 폭 — 창 폭에 맞추되 A4(약 794px)보다 넓게는 키우지 않는다. 배율은 이 폭에 곱한다.
    const baseWidth = Math.min(794, availableWidth())
    let ratio = 1.414 // 쪽 높이/폭 (쪽을 그리면 실제 값으로)
    const holders: HTMLElement[] = []
    const resize = (factor: number): void => {
        const width = Math.round(baseWidth * factor)
        for (const holder of holders) {
            holder.style.width = `${width}px`
            holder.style.minHeight = holder.dataset.done ? '' : `${Math.round(width * ratio)}px`
        }
    }
    // 쪽이 많은 문서도 빨리 열리게 — 화면 근처에 온 쪽만 그린다
    const draw = (holder: HTMLElement): void => {
        if (holder.dataset.done) {
            return
        }
        holder.dataset.done = '1'
        try {
            holder.innerHTML = doc.renderPageSvg(Number(holder.dataset.index))
            const r = prepareSvg(holder)
            if (r > 0) {
                ratio = r
            }
            holder.style.minHeight = ''
        } catch (e: any) {
            holder.textContent = `${Number(holder.dataset.index) + 1}쪽을 그리지 못했습니다: ${e?.message ?? e}`
        }
    }
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (entry.isIntersecting && !(entry.target as HTMLElement).dataset.done) {
                observer.unobserve(entry.target)
                draw(entry.target as HTMLElement)
            }
        }
    }, { rootMargin: '1200px 0px' })
    for (let i = 0; i < count; i++) {
        const holder = document.createElement('div')
        holder.className = 'hv-page'
        holder.dataset.index = String(i)
        pages.appendChild(holder)
        holders.push(holder)
    }
    if (holders[0]) {
        draw(holders[0]) // 첫 쪽으로 쪽 비율을 알아낸다
    }
    onScale(resize)
    for (const holder of holders) {
        if (!holder.dataset.done) {
            observer.observe(holder)
        }
    }
    setStatus(count ? '' : '쪽이 없는 문서입니다')
}

async function showDocx (buffer: ArrayBuffer): Promise<void> {
    const container = document.createElement('div')
    container.className = 'hv-docx'
    app.appendChild(container)
    await renderAsync(buffer, container, undefined, { inWrapper: true, useBase64URL: true, ignoreLastRenderedPageBreak: false })
    // 기본 배율(1) = 쪽이 창보다 넓으면 창 폭에 맞춘 크기. 사용자의 배율은 그 위에 곱한다.
    const fitBase = (): number => {
        const page = container.querySelector('section.docx') as HTMLElement | null
        if (!page) {
            return 1
        }
        zoomOf(container, 1)
        const natural = page.getBoundingClientRect().width
        return natural > availableWidth() ? Math.max(0.2, availableWidth() / natural) : 1
    }
    let base = fitBase()
    onScale(factor => zoomOf(container, base * factor))
    window.addEventListener('resize', () => {
        base = fitBase()
        zoomOf(container, base * scale)
    })
}

function columnName (index: number): string {
    return XLSX.utils.encode_col(index)
}

function showSheets (workbook: XLSX.WorkBook): void {
    const tabs = document.createElement('div')
    tabs.className = 'hv-tabs'
    const body = document.createElement('div')
    body.className = 'hv-sheet'
    app.append(tabs, body)
    const built = new Map<string, HTMLElement>()
    const show = (sheetName: string): void => {
        for (const button of Array.from(tabs.querySelectorAll('.hv-tab'))) {
            button.classList.toggle('active', button.textContent === sheetName)
        }
        body.replaceChildren()
        let view = built.get(sheetName)
        if (!view) {
            view = buildSheet(workbook.Sheets[sheetName])
            built.set(sheetName, view)
        }
        body.appendChild(view)
    }
    for (const sheetName of workbook.SheetNames) {
        const button = document.createElement('button')
        button.className = 'hv-tab'
        button.textContent = sheetName
        button.addEventListener('click', () => show(sheetName))
        tabs.appendChild(button)
    }
    onScale(factor => zoomOf(body, factor))
    if (workbook.SheetNames.length) {
        show(workbook.SheetNames[0])
    } else {
        setStatus('시트가 없는 문서입니다')
    }
}

/** 셀 값은 textContent 로만 넣는다 — 문서 안의 글이 HTML 로 해석될 일이 없다 */
function buildSheet (sheet: XLSX.WorkSheet): HTMLElement {
    const wrap = document.createElement('div')
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true })
    const cols = Math.min(MAX_COLS, rows.reduce((max, row) => Math.max(max, row.length), 0))
    const table = document.createElement('table')
    const head = table.createTHead().insertRow()
    head.appendChild(document.createElement('th')).className = 'row'
    for (let c = 0; c < cols; c++) {
        head.appendChild(document.createElement('th')).textContent = columnName(c)
    }
    const tbody = table.createTBody()
    const shown = Math.min(rows.length, MAX_ROWS)
    for (let r = 0; r < shown; r++) {
        const tr = tbody.insertRow()
        const th = document.createElement('th')
        th.className = 'row'
        th.textContent = String(r + 1)
        tr.appendChild(th)
        for (let c = 0; c < cols; c++) {
            tr.insertCell().textContent = String(rows[r][c] ?? '')
        }
    }
    wrap.appendChild(table)
    if (rows.length > shown || cols >= MAX_COLS) {
        const note = document.createElement('div')
        note.className = 'hv-note'
        note.textContent = `큰 시트라 앞부분(${shown.toLocaleString()}행 × ${cols}열)까지만 보여 줍니다`
        wrap.appendChild(note)
    }
    return wrap
}

async function showPptx (buffer: ArrayBuffer): Promise<void> {
    const container = document.createElement('div')
    container.className = 'hv-pptx'
    app.appendChild(container)
    const width = Math.max(240, Math.min(1100, availableWidth()))
    const previewer = initPptx(container, { width, height: Math.round(width * 9 / 16), mode: 'list' })
    await previewer.preview(buffer)
    onScale(factor => zoomOf(container, factor))
}

function showText (buffer: ArrayBuffer): void {
    const pre = document.createElement('pre')
    pre.className = 'hv-text'
    pre.textContent = decodeText(buffer)
    app.appendChild(pre)
    onScale(factor => zoomOf(pre, factor))
    if (buffer.byteLength > MAX_TEXT) {
        setStatus(`큰 파일이라 앞부분 ${Math.round(MAX_TEXT / 1024 / 1024)}MB 까지만 보여 줍니다`)
    }
}

function showImage (): void {
    const img = document.createElement('img')
    img.className = 'hv-image'
    img.src = fileUrl
    img.alt = name
    app.appendChild(img)
    onScale(factor => zoomOf(img, factor))
}

async function main (): Promise<void> {
    if (!id) {
        throw new Error('열 파일이 지정되지 않았습니다')
    }
    const kind = Object.keys(KINDS).find(k => KINDS[k].includes(ext))
    if (!kind) {
        throw new Error(`.${ext} 형식은 hagis 뷰어에서 열 수 없습니다 (기본 프로그램으로 여세요)`)
    }
    if (kind === 'pdf') {
        showPdf()
        setStatus('')
        return
    }
    if (kind === 'image') {
        showImage()
        setStatus('')
        return
    }
    const buffer = await fetchBuffer()
    switch (kind) {
        case 'hwp':
            await showHwp(buffer)
            break
        case 'docx':
            await showDocx(buffer)
            break
        case 'sheet': {
            const text = ext === 'csv' || ext === 'tsv'
            showSheets(text
                ? XLSX.read(decodeText(buffer), { type: 'string', cellDates: true })
                : XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true }))
            break
        }
        case 'pptx':
            await showPptx(buffer)
            break
        default:
            showText(buffer)
    }
    if (kind !== 'hwp' && kind !== 'text') {
        setStatus('')
    }
}

setStatus('불러오는 중…')
main().then(() => {
    if (statusEl.textContent === '불러오는 중…') {
        setStatus('')
    }
}).catch(e => {
    console.error('[hagis viewer]', e)
    const hint = /password|encrypt|암호/i.test(String(e?.message ?? e)) ? '\n(암호가 걸린 문서는 열 수 없습니다)' : ''
    setStatus(`문서를 열지 못했습니다: ${e?.message ?? e}${hint}`, true)
})
