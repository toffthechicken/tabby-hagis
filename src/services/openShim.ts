/**
 * 웹 패널 페이지에 심는 window.open 관련 코드 모음.
 * 모두 고정 문자열이며 사용자 입력은 들어가지 않는다.
 */

/** 스크립트의 window.open 이 연 창이라는 표식 (창 이름 앞에 붙는다) — 메인 프로세스 처리기가 진짜 창으로 열어 준다 */
export const HAGIS_SCRIPT_OPEN_PREFIX = '__hagis_script_'
/** 스크립트의 window.open 을 패널로 열고 중계한다는 표식 (창 이름 앞에 붙는다) — 뒤에 중계 번호가 붙는다 */
export const HAGIS_RELAY_PREFIX = '__hagis_relay_'

/** 스크립트가 여는 창을 어떻게 다룰지 */
export type HagisScriptOpenMode = 'window' | 'relay' | 'pane'

/**
 * 열어 주는 쪽 페이지에 심는 코드 — 기능 인자 없이 window.open(주소) / (주소, '_blank') 로 여는 창을 다룬다.
 *  - 'window': 창 이름에 표식을 붙여 진짜 창으로 열게 한다 (opener·창 핸들·postMessage 가 그대로 동작)
 *  - 'relay' : http(s) 주소는 패널로 열고, 돌려주는 창 핸들 자리에 가짜 핸들(onload·postMessage·close·closed)을 준다.
 *              메시지는 Hagis 가 새 패널과 주고받게 한다 (JSON 으로 표현되는 값만 전달된다).
 * 크기 등 기능을 지정했거나 이름이 있는 창은 건드리지 않는다.
 */
export function scriptOpenShim (mode: 'window' | 'relay'): string {
    return `(function () {
    if (window.__hagisOpenShim) { return }
    window.__hagisOpenShim = 1
    var relay = ${mode === 'relay' ? 'true' : 'false'}
    var original = window.open
    var count = 0
    var kids = {}
    var outbox = []
    function dup (v) { try { return JSON.parse(JSON.stringify(v === undefined ? null : v)) } catch (e) { return null } }
    function makeKid (id, href) {
        var listeners = {}
        var kid = {
            closed: false, name: '', opener: window, location: { href: href }, onload: null,
            postMessage: function (data, target) {
                if (target && typeof target === 'object') { target = target.targetOrigin }
                outbox.push({ id: id, type: 'msg', data: dup(data), target: target === undefined ? '/' : String(target) })
                if (outbox.length > 200) { outbox.shift() }
            },
            close: function () { outbox.push({ id: id, type: 'close' }) },
            focus: function () { }, blur: function () { },
            addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
            removeEventListener: function (type, fn) { var l = listeners[type]; if (l) { var i = l.indexOf(fn); if (i >= 0) { l.splice(i, 1) } } },
            __fire: function (type) {
                var ev = new Event(type)
                if (type === 'load' && typeof kid.onload === 'function') { try { kid.onload(ev) } catch (e) { setTimeout(function () { throw e }) } }
                ;(listeners[type] || []).slice().forEach(function (fn) { try { fn.call(kid, ev) } catch (e) { setTimeout(function () { throw e }) } })
            }
        }
        return kid
    }
    window.open = function (url, target, features) {
        if (!features && (target === undefined || target === null || target === '' || target === '_blank')) {
            var abs = null
            try { abs = new URL(String(url === undefined || url === null ? '' : url), location.href) } catch (e) { }
            if (relay) {
                if (abs && (abs.protocol === 'http:' || abs.protocol === 'https:')) {
                    var id = 'k' + (++count) + '_' + Date.now().toString(36)
                    var kid = makeKid(id, abs.href)
                    kids[id] = kid
                    original.call(this, abs.href, '${HAGIS_RELAY_PREFIX}' + id)
                    return kid
                }
            } else {
                target = '${HAGIS_SCRIPT_OPEN_PREFIX}' + (++count) + '_' + Date.now().toString(36)
            }
        }
        return original.call(this, url, target, features)
    }
    Object.defineProperty(window, '__hagisRelay', { configurable: true, value: {
        drain: function (id) {
            var mine = [], rest = []
            outbox.forEach(function (m) { (m.id === id ? mine : rest).push(m) })
            outbox = rest
            return JSON.stringify(mine)
        },
        deliver: function (json) {
            var list
            try { list = JSON.parse(json) } catch (e) { return }
            list.forEach(function (m) {
                var kid = kids[m.id]
                if (!kid) { return }
                if (m.type === 'msg') {
                    var ev = new MessageEvent('message', { data: m.data, origin: m.from || '' })
                    try { Object.defineProperty(ev, 'source', { value: kid }) } catch (e) { }
                    window.dispatchEvent(ev)
                } else if (m.type === 'load') {
                    kid.__fire('load')
                } else if (m.type === 'closed') {
                    kid.closed = true
                }
            })
        }
    } })
})()`
}

/**
 * 중계로 열린 새 패널의 페이지에 문서가 열리기 전에 심는 코드 — 가짜 window.opener 와 window.close.
 * 최상위 문서에만 적용한다.
 */
export const HAGIS_OPENER_SHIM = `(function () {
    if (window !== window.top) { return }
    var out = []
    function dup (v) { try { return JSON.parse(JSON.stringify(v === undefined ? null : v)) } catch (e) { return null } }
    var opener = {
        closed: false,
        postMessage: function (data, target) {
            if (target && typeof target === 'object') { target = target.targetOrigin }
            out.push({ type: 'msg', data: dup(data), target: target === undefined ? '/' : String(target) })
            if (out.length > 200) { out.shift() }
        },
        focus: function () { }, blur: function () { }, close: function () { }
    }
    try { Object.defineProperty(window, 'opener', { configurable: true, get: function () { return opener }, set: function () { } }) } catch (e) { }
    window.close = function () { out.push({ type: 'close' }) }
    Object.defineProperty(window, '__hagisOpener', { configurable: true, value: {
        drain: function () { var o = out; out = []; return JSON.stringify(o) },
        deliver: function (json) {
            var list
            try { list = JSON.parse(json) } catch (e) { return }
            list.forEach(function (m) {
                if (m.type === 'msg') {
                    var ev = new MessageEvent('message', { data: m.data, origin: m.from || '' })
                    try { Object.defineProperty(ev, 'source', { value: opener }) } catch (e) { }
                    window.dispatchEvent(ev)
                } else if (m.type === 'closed') {
                    opener.closed = true
                }
            })
        }
    } })
})()`

/** postMessage 의 대상 출처(targetOrigin)가 받는 쪽과 맞는지 — 브라우저와 같은 규칙 */
export function targetOriginMatches (target: string, senderOrigin: string, receiverOrigin: string): boolean {
    if (!receiverOrigin) {
        return false
    }
    if (target === '*') {
        return true
    }
    if (target === '/' || target === '') {
        return senderOrigin === receiverOrigin
    }
    try {
        return new URL(target).origin === receiverOrigin
    } catch {
        return false
    }
}
