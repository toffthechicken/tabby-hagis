/**
 * 주소창 입력 해석 — 주소인지, 검색어인지
 *
 * Chrome 주소창과 같은 방식이다: 주소처럼 생겼으면 그 주소로 가고, 아니면 검색한다.
 *  - 스킴이 있으면(https://…, about:…) 주소
 *  - 띄어쓰기가 있으면 검색어
 *  - localhost, IPv4(192.168.1.1[:포트][/경로]), [IPv6], 호스트:포트(fw01:8443), 점이 있는 도메인(naver.com, 한글.kr)은 주소
 *  - 그 밖(점 없는 한 단어 포함)은 검색어
 */

export type HagisSearchEngine = 'google' | 'naver' | 'bing' | 'duckduckgo' | 'off'

export const HAGIS_SEARCH_ENGINES: Record<Exclude<HagisSearchEngine, 'off'>, { label: string, url: string }> = {
    google: { label: 'Google', url: 'https://www.google.com/search?q=' },
    naver: { label: '네이버', url: 'https://search.naver.com/search.naver?query=' },
    bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
    duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const DOMAIN = /^([a-z0-9가-힣]([a-z0-9가-힣-]*[a-z0-9가-힣])?\.)+([a-z]{2,}|xn--[a-z0-9-]+|[가-힣]{2,})$/i
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/** 입력이 주소(URL)처럼 보이는가 */
export function looksLikeAddress (input: string): boolean {
    const value = input.trim()
    if (!value) {
        return false
    }
    if (SCHEME.test(value) || /^about:/i.test(value)) {
        return true
    }
    if (/\s/.test(value)) {
        return false
    }
    const hostPort = value.split(/[/?#]/)[0]
    if (/^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(hostPort)) {
        return true
    }
    const match = /^(.*?)(?::(\d{1,5}))?$/.exec(hostPort)
    const host = match?.[1] ?? ''
    const port = match?.[2]
    if (!host) {
        return false
    }
    if (host.toLowerCase() === 'localhost') {
        return true
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return host.split('.').every(part => Number(part) <= 255)
    }
    if (port) {
        return HOSTNAME.test(host) // fw01:8443
    }
    return DOMAIN.test(host)
}

/** 검색어를 해당 검색 엔진의 검색 주소로 */
export function searchUrlFor (query: string, engine: HagisSearchEngine): string {
    if (engine === 'off') {
        return ''
    }
    const base = HAGIS_SEARCH_ENGINES[engine] ?? HAGIS_SEARCH_ENGINES.google
    return base.url + encodeURIComponent(query.trim()).replace(/%20/g, '+')
}

/** 주소창 입력이 검색어로 처리되어야 하는가 (검색 엔진이 꺼져 있으면 항상 주소) */
export function isSearchInput (input: string, engine: HagisSearchEngine): boolean {
    return engine !== 'off' && !!input.trim() && !looksLikeAddress(input)
}
